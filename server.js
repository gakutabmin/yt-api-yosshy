import 'dotenv/config';
import express from 'express';
import { spawn } from 'node:child_process';

// ------------------------
// Environment / Constants
// ------------------------
const DEFAULT_PORT = 3000;
const REQUEST_TIMEOUT_MS = 5_000;
const INSTANCE_BAN_MS = 5 * 60_000;
const YT_DLP_TIMEOUT_MS = 10_000;
const YT_DLP_STDOUT_LIMIT = 5 * 1024 * 1024;
const YT_DLP_STDERR_LIMIT = 1 * 1024 * 1024;
const YT_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

const YT_DLP_BIN = process.env.YT_DLP_BIN || '/opt/venv/bin/yt-dlp';
const PROXY_URL = (() => {
  const raw = process.env.PROXY_URL;
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
})();

const PORT = (() => {
  const parsed = Number.parseInt(String(process.env.PORT ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : DEFAULT_PORT;
})();

const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.f5.si',
  'https://invidious.lunivers.trade',
  'https://iv.melmac.space',
  'https://yt.omada.cafe',
  'https://invidious.nerdvpn.de',
  'https://invidious.tiekoetter.com',
  'https://yewtu.be',
];

const MANIFEST_KEYS = ['dashManifestUrl', 'hlsManifestUrl', 'manifestUrl'];

// ------------------------
// App
// ------------------------
const app = express();
app.disable('x-powered-by');

// ------------------------
// Helpers
// ------------------------
class SkipInstanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkipInstanceError';
  }
}

const isPlainObject = (value) =>
  Boolean(value) &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.prototype.toString.call(value) === '[object Object]';

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const snippet = (text, len = 220) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > len ? `${s.slice(0, len)}…` : s;
};

const parseStrictJsonObject = (text, context = 'json') => {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    throw new Error(`${context}: empty output`);
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${context}: invalid JSON (${snippet(trimmed)})`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`${context}: JSON must be an object`);
  }

  return parsed;
};

const parseHeightFromLabel = (label) => {
  const m = String(label || '').match(/(\d{3,4})p/i);
  return m ? Number(m[1]) : 0;
};

const parseUrlFromFormat = (format) => {
  if (!isPlainObject(format)) return null;
  if (isNonEmptyString(format.url)) return format.url;

  const cipher = isNonEmptyString(format.signatureCipher) ? format.signatureCipher : null;
  if (!cipher) return null;

  try {
    return new URLSearchParams(cipher).get('url');
  } catch {
    return null;
  }
};

const uniqueBy = (items, keyFn) => {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
};

const asObjectArray = (...values) =>
  values.flatMap((value) => (Array.isArray(value) ? value : [])).filter(isPlainObject);

const collectFormats = (raw = {}, sd = {}) => {
  const sources = asObjectArray(
    raw.formats,
    raw.requested_formats,
    raw.adaptiveFormats,
    sd.formats,
    sd.requested_formats,
    sd.adaptiveFormats,
    sd.streamingData?.formats,
    sd.streamingData?.requested_formats,
    sd.streamingData?.adaptiveFormats
  );

  const normalized = sources
    .map((format) => {
      const url = parseUrlFromFormat(format);
      if (!url) return null;

      const mime = String(format.mimeType || '').toLowerCase();
      const vcodec = String(format.vcodec || '').toLowerCase();
      const acodec = String(format.acodec || '').toLowerCase();

      return {
        ...format,
        url,
        mime,
        vcodec,
        acodec,
        width: toNumber(format.width, 0),
        height: toNumber(format.height || parseHeightFromLabel(format.qualityLabel || format.resolution), 0),
        fps: toNumber(format.fps, 0),
        tbr: toNumber(format.tbr || format.bitrate, 0),
        abr: toNumber(format.abr || format.audioBitrate, 0),
        vbr: toNumber(format.vbr, 0),
        filesize: toNumber(format.filesize, 0),
        filesize_approx: toNumber(format.filesize_approx, 0),
        qualityLabel: String(format.qualityLabel || format.resolution || ''),
      };
    })
    .filter(Boolean);

  return uniqueBy(normalized, (format) => {
    return (
      format.url ||
      `${String(format.itag || '')}|${String(format.format_id || '')}|${String(format.height || '')}|${String(format.width || '')}|${String(format.mime || '')}`
    );
  });
};

const extractTitle = (raw = {}) =>
  raw.title ||
  raw.videoDetails?.title ||
  raw.player_response?.videoDetails?.title ||
  raw.basic_info?.title ||
  raw.microformat?.title?.simpleText ||
  null;

const isLiveLike = (raw = {}, sd = {}) =>
  Boolean(
    raw.is_live ||
      raw.isLive ||
      raw.liveNow ||
      raw.live ||
      raw.live_status === 'is_live' ||
      sd.isLive ||
      sd.streamingData?.isLive
  );

const extractManifest = (raw = {}, sd = {}, isLive = false) => {
  const candidates = [
    { kind: 'dash', url: sd.dashManifestUrl },
    { kind: 'hls', url: sd.hlsManifestUrl },
    { kind: 'dash', url: raw.dashManifestUrl },
    { kind: 'hls', url: raw.hlsManifestUrl },
    { kind: null, url: sd.manifestUrl },
    { kind: null, url: raw.manifestUrl },
  ].filter((item) => isNonEmptyString(item.url));

  if (!candidates.length) return null;

  const inferKind = (item) => {
    if (item.kind) return item.kind;
    if (/\.m3u8(\?|#|$)/i.test(item.url)) return 'hls';
    if (/\.mpd(\?|#|$)/i.test(item.url)) return 'dash';
    return 'hls';
  };

  const ordered = candidates.map((item) => ({
    url: item.url,
    kind: inferKind(item),
  }));

  const preferredKinds = isLive ? ['hls', 'dash'] : ['dash', 'hls'];
  for (const kind of preferredKinds) {
    const hit = ordered.find((item) => item.kind === kind);
    if (hit) return hit;
  }

  return ordered[0];
};

const isMuxedFormat = (format) =>
  Boolean(
    format &&
      ((format.vcodec && format.vcodec !== 'none' && format.acodec && format.acodec !== 'none') ||
        (format.mime.includes('video') && format.mime.includes('audio')))
  );

const isVideoOnly = (format) =>
  Boolean(
    format &&
      ((format.vcodec && format.vcodec !== 'none' && (!format.acodec || format.acodec === 'none')) ||
        (format.mime.includes('video') && !format.mime.includes('audio')))
  );

const isAudioOnly = (format) =>
  Boolean(
    format &&
      ((format.acodec && format.acodec !== 'none' && (!format.vcodec || format.vcodec === 'none')) ||
        (format.mime.includes('audio') && !format.mime.includes('video')))
  );

const scoreVideoFormat = (format) => [
  toNumber(format.height, 0),
  toNumber(format.width, 0),
  toNumber(format.fps, 0),
  toNumber(format.tbr || format.vbr || format.abr, 0),
  toNumber(format.filesize_approx || format.filesize, 0),
];

const scoreAudioFormat = (format) => [
  toNumber(format.abr, 0),
  toNumber(format.tbr || format.vbr, 0),
  toNumber(format.filesize_approx || format.filesize, 0),
];

const compareVideoQuality = (a, b) => {
  const A = scoreVideoFormat(a);
  const B = scoreVideoFormat(b);
  for (let i = 0; i < A.length; i += 1) {
    if (B[i] !== A[i]) return B[i] - A[i];
  }
  return 0;
};

const compareAudioQuality = (a, b) => {
  const A = scoreAudioFormat(a);
  const B = scoreAudioFormat(b);
  for (let i = 0; i < A.length; i += 1) {
    if (B[i] !== A[i]) return B[i] - A[i];
  }
  return 0;
};

const selectBestMuxed = (formats = []) =>
  [...formats].filter(isMuxedFormat).sort(compareVideoQuality)[0] || null;

const selectBestVideo = (formats = []) =>
  [...formats].filter(isVideoOnly).sort(compareVideoQuality)[0] ||
  [...formats].filter((format) => format.mime.includes('video')).sort(compareVideoQuality)[0] ||
  null;

const selectBestAudio = (formats = []) =>
  [...formats].filter(isAudioOnly).sort(compareAudioQuality)[0] ||
  [...formats].filter((format) => format.mime.includes('audio')).sort(compareAudioQuality)[0] ||
  null;

const buildStreamingData = (raw = {}) => {
  const streamingData = isPlainObject(raw.streamingData) ? raw.streamingData : {};

  return {
    formats: Array.isArray(raw.formats) ? raw.formats : [],
    requested_formats: Array.isArray(raw.requested_formats) ? raw.requested_formats : [],
    adaptiveFormats: Array.isArray(raw.adaptiveFormats) ? raw.adaptiveFormats : [],
    streamingData,
    ...Object.fromEntries(
      MANIFEST_KEYS.filter((key) => isNonEmptyString(raw[key])).map((key) => [key, raw[key]])
    ),
    isLive: Boolean(raw.isLive),
  };
};

const selectDashFromRequested = (raw = {}, sd = {}) => {
  const requested = asObjectArray(raw.requested_formats, sd.requested_formats, sd.streamingData?.requested_formats);
  if (requested.length < 2) return null;

  const normalized = collectFormats({ requested_formats: requested }, {});
  const video = normalized.find(isVideoOnly);
  const audio = normalized.find(isAudioOnly);

  if (video && audio) {
    return {
      kind: 'dash',
      videourl: parseUrlFromFormat(video),
      audiourl: parseUrlFromFormat(audio),
      source: 'requested_formats',
    };
  }

  return null;
};

const normalizeResourceChoice = (raw = {}, sd = {}) => {
  const formats = collectFormats(raw, sd);
  const live = isLiveLike(raw, sd);

  if (live) {
    const manifest = extractManifest(raw, sd, true);
    if (!manifest) return null;
    return {
      kind: manifest.kind,
      url: manifest.url,
      source: 'manifest',
    };
  }

  const requestedDash = selectDashFromRequested(raw, sd);
  if (requestedDash?.videourl && requestedDash?.audiourl) {
    return requestedDash;
  }

  const video = selectBestVideo(formats);
  const audio = selectBestAudio(formats);

  if (video && audio) {
    return {
      kind: 'dash',
      videourl: parseUrlFromFormat(video),
      audiourl: parseUrlFromFormat(audio),
      source: 'adaptive',
    };
  }

  const muxed = selectBestMuxed(formats);
  if (muxed) {
    return {
      kind: 'progressive',
      url: parseUrlFromFormat(muxed),
      source: 'muxed',
    };
  }

  return null;
};

// ------------------------
// yt-dlp
// ------------------------
const runYtDlp = async (videoId, { useProxy = false } = {}) => {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const args = [
    '--dump-single-json',
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--format',
    'bestvideo*+bestaudio/best',
  ];

  if (useProxy && PROXY_URL) {
    args.push('--proxy', PROXY_URL);
  }

  args.push(url);

  return new Promise((resolve, reject) => {
    const child = spawn(YT_DLP_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(new Error('yt-dlp timed out'));
    }, YT_DLP_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > YT_DLP_STDOUT_LIMIT) {
        child.kill('SIGKILL');
        done(new Error('yt-dlp stdout exceeded limit'));
        return;
      }
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > YT_DLP_STDERR_LIMIT) {
        child.kill('SIGKILL');
        done(new Error('yt-dlp stderr exceeded limit'));
        return;
      }
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      done(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;

      if (code !== 0) {
        done(
          new Error(
            `yt-dlp failed (${code ?? signal ?? 'unknown'}): ${snippet(stderr) || 'no stderr output'}`
          )
        );
        return;
      }

      try {
        done(null, parseStrictJsonObject(stdout, 'yt-dlp stdout'));
      } catch (err) {
        done(err);
      }
    });
  });
};

// ------------------------
// Invidious
// ------------------------
const badInstances = new Map();
let rrIndex = 0;

const markInstanceBad = (instance) => {
  badInstances.set(instance, Date.now());
};

const rotateInstances = (list = []) => {
  if (!Array.isArray(list) || list.length === 0) return [];

  const start = rrIndex % list.length;
  rrIndex = (rrIndex + 1) % list.length;

  const rotated = [...list.slice(start), ...list.slice(0, start)];

  const now = Date.now();
  const available = rotated.filter((instance) => {
    const time = badInstances.get(instance);
    if (!time) return true;
    if (now - time > INSTANCE_BAN_MS) {
      badInstances.delete(instance);
      return true;
    }
    return false;
  });

  return available.length ? available : rotated;
};

const fastestFetch = async (instances, buildUrl, parser) => {
  if (!Array.isArray(instances) || instances.length === 0) throw new Error('no instances');

  const controllers = [];

  const tasks = instances.map((base) =>
    (async () => {
      const controller = new AbortController();
      controllers.push(controller);

      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(buildUrl(base), {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });

        if (!res.ok) {
          markInstanceBad(base);
          throw new Error(`bad response ${res.status} from ${base}`);
        }

        const json = await res.json();
        if (!isPlainObject(json)) {
          markInstanceBad(base);
          throw new Error(`non-object JSON from ${base}`);
        }

        const parsed = parser(json);
        if (!parsed) {
          throw new Error(`parse failed from ${base}`);
        }

        return { instance: base, data: parsed };
      } catch (err) {
        if (!(err instanceof SkipInstanceError)) {
          const aborted = err?.name === 'AbortError';
          if (timedOut || !aborted) markInstanceBad(base);
        }
        throw err;
      } finally {
        clearTimeout(timeout);
      }
    })()
  );

  try {
    const result = await Promise.any(tasks);
    controllers.forEach((controller) => controller.abort());
    return result;
  } catch (err) {
    controllers.forEach((controller) => controller.abort());
    throw err instanceof AggregateError ? new Error('All instances failed') : err;
  }
};

const parseInvidiousVideo = (data) => {
  if (!isPlainObject(data)) return null;

  const sd = buildStreamingData(data);
  const live = Boolean(data.liveNow || data.isLive || data.is_live || data.live || data.live_status === 'is_live' || sd.isLive);

  if (live) {
    throw new SkipInstanceError('skip live on invidious');
  }

  return {
    streaming_data: sd,
    is_live: live,
    raw: data,
  };
};

const fetchFromYtDlp = async (id, { useProxy = false } = {}) => {
  const raw = await runYtDlp(id, { useProxy });
  if (!isPlainObject(raw)) throw new Error('yt-dlp returned non-object JSON');

  const sd = buildStreamingData(raw);
  const formats = collectFormats(raw, sd);
  const live = isLiveLike(raw, sd);

  return {
    provider: useProxy ? 'yt-dlp (proxy)' : 'yt-dlp (direct)',
    streaming_data: sd,
    is_live: live,
    raw,
    formats,
  };
};

const fetchFromInvidious = async (id) => {
  const instances = rotateInstances(INVIDIOUS_INSTANCES);

  const result = await fastestFetch(
    instances,
    (base) => `${base.replace(/\/$/, '')}/api/v1/videos/${id}`,
    parseInvidiousVideo
  );

  return {
    provider: result.instance,
    streaming_data: result.data.streaming_data,
    is_live: result.data.is_live,
    raw: result.data.raw,
  };
};

const fetchStreamingInfo = async (id) => {
  if (PROXY_URL) {
    try {
      return await fetchFromYtDlp(id, { useProxy: true });
    } catch (error) {
      console.warn('proxied yt-dlp failed, falling back to invidious:', error?.message || error);
    }
  }

  try {
    return await fetchFromInvidious(id);
  } catch (error) {
    console.warn('invidious failed, falling back to direct yt-dlp:', error?.message || error);
  }

  return fetchFromYtDlp(id, { useProxy: false });
};

const buildStreamResponse = ({ info, raw, sd, title, res }) => {
  const formats = collectFormats(raw, sd);
  const live = isLiveLike(raw, sd);

  if (live) {
    const manifest = extractManifest(raw, sd, true);
    if (!manifest) {
      return res.status(404).json({ error: 'no stream' });
    }

    return res.json({
      resourcetype: manifest.kind || 'hls',
      title,
      url: manifest.url,
      provider: info.provider,
    });
  }

  if (!formats.length) {
    return res.status(404).json({ error: 'no stream' });
  }

  const choice = normalizeResourceChoice(raw, sd);
  if (!choice) {
    return res.status(404).json({ error: 'no stream' });
  }

  if (choice.kind === 'dash') {
    if (choice.videourl && choice.audiourl) {
      return res.json({
        resourcetype: 'dash',
        title,
        videourl: choice.videourl,
        audiourl: choice.audiourl,
        provider: info.provider,
      });
    }
    return res.status(404).json({ error: 'no stream' });
  }

  if (choice.kind === 'progressive') {
    return res.json({
      resourcetype: 'progressive',
      title,
      url: choice.url,
      provider: info.provider,
    });
  }

  return res.status(404).json({ error: 'no stream' });
};

// ------------------------
// API
// ------------------------
app.get('/api/stream', async (req, res) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id required' });
    if (!YT_ID_REGEX.test(id)) return res.status(400).json({ error: 'invalid video id' });

    const info = await fetchStreamingInfo(id);
    const sd = info.streaming_data || {};
    const raw = info.raw || {};
    const title = extractTitle(raw) || '';

    return buildStreamResponse({ info, raw, sd, title, res });
  } catch (error) {
    console.error('Unexpected error in /api/stream', error);
    return res.status(500).json({ error: error?.message || 'internal error' });
  }
});

// ------------------------
// Server start
// ------------------------
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
