import 'dotenv/config';
import express from 'express';
import { spawn } from 'node:child_process';

const DEFAULT_PORT = 3000;
const REQUEST_TIMEOUT_MS = 5_000;
const INSTANCE_BAN_MS = 5 * 60 * 1000;
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
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
})();

const PORT = (() => {
  const parsed = Number.parseInt(String(process.env.PORT ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : DEFAULT_PORT;
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

const TITLE_PATH = 'title';

const MANIFEST_FIELD_GROUPS = [
  { kind: 'dash', key: 'dashUrl' },
  { kind: 'hls', key: 'hlsUrl' },
];

const VIDEO_SCORE_RULES = ['height', 'width', 'fps', 'tbr', 'filesize_approx', 'filesize'];
const AUDIO_SCORE_RULES = ['abr', 'tbr', 'filesize_approx', 'filesize'];

const app = express();
app.disable('x-powered-by');

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
  if (!trimmed) throw new Error(`${context}: empty output`);

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${context}: invalid JSON (${snippet(trimmed)})`);
  }

  if (!isPlainObject(parsed)) throw new Error(`${context}: JSON must be an object`);
  return parsed;
};

const getPathValue = (source, path) => {
  if (!isPlainObject(source) && !Array.isArray(source)) return undefined;

  const parts = Array.isArray(path) ? path : String(path).split('.');
  let current = source;

  for (const part of parts) {
    if (current == null) return undefined;
    current = current?.[part];
  }

  return current;
};

const firstDefined = (...values) => {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return null;
};

const firstNonEmptyString = (...values) => {
  for (const value of values) {
    if (isNonEmptyString(value)) return String(value).trim();
  }
  return null;
};

const firstStringFromPaths = (source, paths) => {
  for (const path of paths) {
    const value = getPathValue(source, path);
    if (isNonEmptyString(value)) return String(value).trim();
  }
  return null;
};

const concatTextRuns = (runs) =>
  Array.isArray(runs)
    ? runs.map((part) => part?.text || '').join('').trim() || null
    : null;

const parseHeightFromLabel = (label) => {
  const match = String(label || '').match(/(\d{3,4})p/i);
  return match ? Number(match[1]) : 0;
};

const parseUrlFromFormat = (format) => {
  if (!format) return null;
  if (typeof format === 'string') return format;
  if (isNonEmptyString(format.url)) return format.url;

  const cipher = format.signatureCipher || format.signature_cipher || format.cipher;
  if (!cipher) return null;

  try {
    const params = new URLSearchParams(cipher);
    return params.get('url');
  } catch {
    return null;
  }
};

const normalizeFormatKindToken = (value) => {
  const token = firstNonEmptyString(value)?.toLowerCase();
  if (!token) return null;

  if (token === 'progressive') return 'muxed';
  if (token === 'combined') return 'muxed';
  if (token === 'video' || token === 'audio' || token === 'muxed') return token;
  return null;
};

const inferFormatKind = (format) => {
  if (!isPlainObject(format)) return null;

  const explicit = normalizeFormatKindToken(format.kind);
  if (explicit) return explicit;

  const mimeText = [
    format.mime,
    format.mimeType,
    format.mime_type,
    format.type,
    format.container,
    format.encoding,
    format.qualityLabel,
    format.quality_label,
    format.resolution,
  ]
    .filter(isNonEmptyString)
    .join(' ')
    .toLowerCase();

  const codecText = [format.vcodec, format.acodec].filter(isNonEmptyString).join(' ').toLowerCase();
  const text = `${mimeText} ${codecText}`;

  const hasVideoSignal =
    toNumber(format.width, 0) > 0 ||
    toNumber(format.height, 0) > 0 ||
    toNumber(format.fps, 0) > 0 ||
    isNonEmptyString(format.qualityLabel) ||
    isNonEmptyString(format.quality_label) ||
    isNonEmptyString(format.resolution);

  const hasAudioSignal =
    isNonEmptyString(format.audioQuality) ||
    isNonEmptyString(format.audioQualityLabel) ||
    isNonEmptyString(format.audioSampleRate) ||
    isNonEmptyString(format.audioChannels);

  const mentionsVideo = /video|avc|vp9|vp8|av01|h264|h265|hevc/.test(text);
  const mentionsAudio = /audio|aac|opus|mp4a|vorbis|flac|mp3/.test(text);

  if (mentionsVideo && mentionsAudio) return 'muxed';
  if (mentionsAudio && !mentionsVideo) return 'audio';
  if (mentionsVideo && !mentionsAudio) return 'video';

  if (hasVideoSignal && hasAudioSignal) return 'muxed';
  if (hasVideoSignal) return 'video';
  if (hasAudioSignal) return 'audio';

  return null;
};

const uniqByKey = (items, keyFn) => {
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

const flattenArrays = (...values) => values.flatMap((value) => (Array.isArray(value) ? value : [])).filter(Boolean);

const normalizeFormat = (format) => {
  if (!isPlainObject(format)) return null;

  const url = parseUrlFromFormat(format);
  const mime = firstNonEmptyString(format.mimeType, format.mime_type, format.type)?.toLowerCase() || '';
  const vcodec = firstNonEmptyString(format.vcodec)?.toLowerCase() || '';
  const acodec = firstNonEmptyString(format.acodec)?.toLowerCase() || '';
  const kind = inferFormatKind(format);

  return {
    ...format,
    url,
    mime,
    vcodec,
    acodec,
    kind,
    width: toNumber(format.width, 0),
    height: toNumber(firstDefined(format.height, parseHeightFromLabel(firstNonEmptyString(format.qualityLabel, format.resolution))), 0),
    fps: toNumber(format.fps, 0),
    tbr: toNumber(firstDefined(format.tbr, format.bitrate, format.total_bitrate), 0),
    abr: toNumber(firstDefined(format.abr, format.audioBitrate), 0),
    vbr: toNumber(format.vbr, 0),
    filesize: toNumber(format.filesize, 0),
    filesize_approx: toNumber(format.filesize_approx, 0),
    qualityLabel: firstNonEmptyString(format.qualityLabel, format.quality_label, format.resolution) || '',
  };
};

const normalizeFormatList = (formats = []) =>
  uniqByKey(
    (Array.isArray(formats) ? formats : [])
      .map((format) => normalizeFormat(format))
      .filter((format) => Boolean(format) && isNonEmptyString(format.url)),
    (format) =>
      format.url ||
      `${String(format.itag || '')}|${String(format.format_id || '')}|${String(format.height || '')}|${String(format.width || '')}|${String(format.mime || '')}`
  );

const pickRequestedFormats = (raw = {}, sd = {}) =>
  flattenArrays(raw.requested_formats, sd.requested_formats, sd.streamingData?.requested_formats).filter(
    (value) => value && typeof value === 'object'
  );

const buildSdFromRaw = (raw = {}) => {
  const sd = {
    formats: Array.isArray(raw.formats) ? raw.formats : [],
    requested_formats: Array.isArray(raw.requested_formats) ? raw.requested_formats : [],
  };

  if (raw.streamingData && isPlainObject(raw.streamingData)) {
    sd.streamingData = raw.streamingData;
  }

  if (Array.isArray(raw.adaptiveFormats)) sd.adaptiveFormats = raw.adaptiveFormats;
  if (Array.isArray(raw.adaptive_formats)) sd.adaptive_formats = raw.adaptive_formats;
  if (Array.isArray(raw.formatStreams)) sd.formatStreams = raw.formatStreams;

  return sd;
};

const collectFormats = (raw = {}, sd = {}) => {
  const sources = flattenArrays(
    raw.formats,
    raw.requested_formats,
    raw.adaptiveFormats,
    raw.adaptive_formats,
    raw.formatStreams,
    sd.formats,
    sd.requested_formats,
    sd.adaptiveFormats,
    sd.adaptive_formats,
    sd.formatStreams,
    sd.streamingData?.formats,
    sd.streamingData?.requested_formats,
    sd.streamingData?.adaptiveFormats,
    sd.streamingData?.adaptive_formats,
    sd.streamingData?.formatStreams
  );

  return normalizeFormatList(sources);
};

const extractTitle = (raw = {}) => {
  const title = raw[TITLE_PATH];
  if (title) return title;

  const runs = getPathValue(raw, ['titleText', 'runs']);
  const joined = concatTextRuns(runs);
  if (joined) return joined;

  const microformat = firstStringFromPaths(raw, [['microformat', 'title', 'simpleText']]);
  if (microformat) return microformat;

  return null;
};

const isLiveLike = (raw = {}, sd = {}) => {
  const liveFlags = [
    raw.is_live,
    raw.liveNow,
    raw.isLive,
    raw.live,
    sd.isLive,
    sd.streamingData?.isLive,
  ];

  if (liveFlags.some((value) => value === true)) return true;

  const status = firstNonEmptyString(raw.live_status, raw.liveStatus, sd.live_status, sd.liveStatus);
  if (!status) return false;

  const normalized = status.toLowerCase();
  return normalized === 'is_live' || normalized === 'live' || normalized === 'live_now' || normalized === 'is-live';
};

const isHlsUrl = (url) => /(^|[/?#&])[^?#]*\.m3u8(\?|#|$)/i.test(url) || /mpegurl/i.test(url);
const isDashUrl = (url) => /(^|[/?#&])[^?#]*\.mpd(\?|#|$)/i.test(url) || /dash/i.test(url);

const readManifestKey = (source, key) => firstNonEmptyString(source?.[key], source?.streamingData?.[key]);

const extractManifest = (raw = {}, sd = {}, preferLive = false) => {
  const candidates = [];

  for (const source of [sd, raw]) {
    for (const group of MANIFEST_FIELD_GROUPS) {
      const url = readManifestKey(source, group.key);
      if (url) candidates.push({ kind: group.kind, url });
    }
  }

  const deduped = uniqByKey(candidates, (candidate) => candidate.url);
  if (!deduped.length) return null;

  const resolved = deduped.map((candidate) => {
    if (candidate.kind) return candidate;
    if (isHlsUrl(candidate.url)) return { ...candidate, kind: 'hls' };
    if (isDashUrl(candidate.url)) return { ...candidate, kind: 'dash' };
    return { ...candidate, kind: 'hls' };
  });

  const preferredKinds = preferLive ? ['hls', 'dash'] : ['dash', 'hls'];
  for (const kind of preferredKinds) {
    const hit = resolved.find((candidate) => candidate.kind === kind);
    if (hit) return hit;
  }

  return resolved[0];
};

const hasPlayableUrl = (format) => isNonEmptyString(format?.url);

const compareByRules = (rules) => (a, b) => {
  for (const key of rules) {
    const left = toNumber(a?.[key], 0);
    const right = toNumber(b?.[key], 0);
    if (left !== right) return right - left;
  }
  return 0;
};

const compareVideoQuality = compareByRules(VIDEO_SCORE_RULES);
const compareAudioQuality = compareByRules(AUDIO_SCORE_RULES);
const compareMuxedQuality = compareVideoQuality;

const selectBestByKind = (formats = [], kind, comparator, fallbackMatcher = null) => {
  const playable = Array.isArray(formats) ? formats.filter(hasPlayableUrl) : [];
  const byKind = playable.filter((format) => format.kind === kind);
  if (byKind.length) return [...byKind].sort(comparator)[0] || null;

  if (!fallbackMatcher) return null;
  const fallback = playable.filter(fallbackMatcher);
  return fallback.length ? [...fallback].sort(comparator)[0] || null : null;
};

const mimeSuggestsVideoOnly = (format) => {
  const text = `${format?.mime || ''} ${format?.vcodec || ''} ${format?.acodec || ''}`.toLowerCase();
  return /video/.test(text) && !/audio/.test(text);
};

const mimeSuggestsAudioOnly = (format) => {
  const text = `${format?.mime || ''} ${format?.vcodec || ''} ${format?.acodec || ''}`.toLowerCase();
  return /audio/.test(text) && !/video/.test(text);
};

const mimeSuggestsMuxed = (format) => {
  const text = `${format?.mime || ''} ${format?.vcodec || ''} ${format?.acodec || ''}`.toLowerCase();
  return /video/.test(text) && /audio/.test(text);
};

const selectBestMuxed = (formats = []) => selectBestByKind(formats, 'muxed', compareMuxedQuality, mimeSuggestsMuxed);
const selectBestVideo = (formats = []) => selectBestByKind(formats, 'video', compareVideoQuality, mimeSuggestsVideoOnly);
const selectBestAudio = (formats = []) => selectBestByKind(formats, 'audio', compareAudioQuality, mimeSuggestsAudioOnly);

const selectDashFromRequested = (raw = {}, sd = {}) => {
  const requested = pickRequestedFormats(raw, sd);
  if (requested.length < 2) return null;

  const normalized = normalizeFormatList(requested);
  const video = normalized.find((format) => format.kind === 'video');
  const audio = normalized.find((format) => format.kind === 'audio');

  if (!video || !audio) return null;

  return {
    kind: 'dash',
    videourl: parseUrlFromFormat(video),
    audiourl: parseUrlFromFormat(audio),
    source: 'requested_formats',
  };
};

const buildStreamState = (raw = {}) => {
  const sd = buildSdFromRaw(raw);
  const formats = collectFormats(raw, sd);

  return {
    raw,
    sd,
    formats,
    live: isLiveLike(raw, sd),
    title: extractTitle(raw),
  };
};

const normalizeResourceChoice = (state = {}) => {
  const raw = state.raw || {};
  const sd = state.sd || {};
  const formats = Array.isArray(state.formats) ? state.formats : [];
  const live = Boolean(state.live);

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
  if (requestedDash?.videourl && requestedDash?.audiourl) return requestedDash;

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
      url: muxed.url,
      source: 'muxed',
    };
  }

  return null;
};

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

  if (useProxy && PROXY_URL) args.push('--proxy', PROXY_URL);
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

    child.on('error', (err) => done(err));

    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        done(new Error(`yt-dlp failed (${code ?? signal ?? 'unknown'}): ${snippet(stderr) || 'no stderr output'}`));
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

class InstancePool {
  constructor(instances = [], banMs = INSTANCE_BAN_MS) {
    this.instances = Array.isArray(instances) ? instances.slice() : [];
    this.banMs = banMs;
    this.badInstances = new Map();
    this.rrIndex = 0;
  }

  markBad(instance) {
    this.badInstances.set(instance, Date.now());
  }

  rotate() {
    if (!this.instances.length) return [];

    const start = this.rrIndex % this.instances.length;
    this.rrIndex = (this.rrIndex + 1) % this.instances.length;

    const rotated = [...this.instances.slice(start), ...this.instances.slice(0, start)];
    const now = Date.now();

    const available = rotated.filter((instance) => {
      const timestamp = this.badInstances.get(instance);
      if (!timestamp) return true;

      if (now - timestamp > this.banMs) {
        this.badInstances.delete(instance);
        return true;
      }

      return false;
    });

    return available.length ? available : rotated;
  }
}

const instancePool = new InstancePool(INVIDIOUS_INSTANCES);

const fastestFetch = async (instances, buildUrl, parser, { markBad = () => {} } = {}) => {
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

        if (!res.ok) throw new Error(`bad response ${res.status} from ${base}`);

        const json = await res.json();
        if (!isPlainObject(json)) throw new Error(`non-object JSON from ${base}`);

        const parsed = parser(json);
        if (!parsed) throw new Error(`parse failed from ${base}`);

        return { instance: base, data: parsed };
      } catch (err) {
        const aborted = err?.name === 'AbortError';
        if (!(err instanceof SkipInstanceError) && (timedOut || !aborted)) {
          markBad(base);
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
  } catch {
    controllers.forEach((controller) => controller.abort());
    throw new Error('All instances failed');
  }
};

const parseInvidiousVideo = (data) => {
  if (!isPlainObject(data)) return null;

  const state = buildStreamState(data);
  if (state.live) {
    throw new SkipInstanceError('skip live on invidious');
  }

  return {
    state,
    streaming_data: {
      ...state.sd,
      formats: state.formats,
    },
    is_live: state.live,
    raw: data,
    formats: state.formats,
  };
};

const fetchFromYtDlp = async (id, { useProxy = false } = {}) => {
  const raw = await runYtDlp(id, { useProxy });
  if (!isPlainObject(raw)) throw new Error('yt-dlp returned non-object JSON');

  const state = buildStreamState(raw);

  return {
    state,
    provider: useProxy ? 'yt-dlp (proxy)' : 'yt-dlp (direct)',
    streaming_data: state.sd,
    is_live: state.live,
    raw,
    formats: state.formats,
  };
};

const fetchFromInvidious = async (id) => {
  const instances = instancePool.rotate();

  const result = await fastestFetch(
    instances,
    (base) => `${base.replace(/\/$/, '')}/api/v1/videos/${id}`,
    parseInvidiousVideo,
    { markBad: (instance) => instancePool.markBad(instance) }
  );

  return {
    state: result.data.state,
    provider: result.instance,
    streaming_data: result.data.streaming_data,
    is_live: result.data.is_live,
    raw: result.data.raw,
    formats: result.data.formats,
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

const getStateFromInfo = (info = {}) => {
  if (info.state && isPlainObject(info.state)) return info.state;

  const raw = info.raw || {};
  const sd = info.streaming_data || {};
  const formats = Array.isArray(info.formats) ? info.formats : collectFormats(raw, sd);

  return {
    raw,
    sd,
    formats,
    live: isLiveLike(raw, sd),
    title: extractTitle(raw),
  };
};

const buildStreamResponse = ({ info, title, res }) => {
  const state = getStateFromInfo(info);
  const raw = state.raw || {};
  const sd = state.sd || {};

  if (state.live) {
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

  const effectiveFormats = Array.isArray(state.formats) ? state.formats : [];
  if (!effectiveFormats.length) {
    return res.status(404).json({ error: 'no stream' });
  }

  const choice = normalizeResourceChoice(state);
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

app.get('/api/stream', async (req, res) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id required' });
    if (!YT_ID_REGEX.test(id)) return res.status(400).json({ error: 'invalid video id' });

    const info = await fetchStreamingInfo(id);
    const title = extractTitle(info.raw || {}) || '';

    return buildStreamResponse({ info, title, res });
  } catch (error) {
    console.error('Unexpected error in /api/stream', error);
    return res.status(500).json({ error: error?.message || 'internal error' });
  }
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
