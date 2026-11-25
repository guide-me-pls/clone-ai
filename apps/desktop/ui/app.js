const MAIN_CONVERSATION_ID = "main-agent-conversation";
const $ = (id) => document.getElementById(id);
const ui = window.CloneUI;
const state = {
  signatures: {},
  drafts: new Map(),
  dashboard: null,
  selectedId: localStorage.getItem("clone-ai:selected-session"),
  composingNew: false,
  // A task whose first message has not been sent yet. Minting it at send time
  // would give a retry a second conversation; minting it on "new task" lets a
  // failed send keep the same task id.
  // 尚未发送第一条消息的任务。到发送时才生成会让重试产生第二个对话；在"新请求"时生成，
  // 失败的发送就能保住同一个任务 id。
  newConversationId: null,
  // Live turns keyed by conversation. One task streaming must not lock the
  // composer for another task, and a completion may only change the selection
  // of the conversation it belongs to.
  // 按对话记录正在运行的回合。一个任务的流不应锁住另一个任务的输入框；回合完成也只能改变
  // 它所属对话的选择状态。
  streams: new Map(),
  // A new-request send is being routed to a Main Agent; a periodic refresh must
  // not wipe the live card before the stream starts.
  // 新请求正在被路由到 Main Agent；周期刷新不得在流开始前抹掉实时卡片。
  routing: false,
  // What was selected when "新请求" was pressed, so the router can decide between
  // continuing it and starting a fresh Main Agent.
  // 按下"新请求"时选中的内容，供路由器在沿用与新开 Main Agent 之间判断。
  routeContext: null,
  streaming: false,
  sessionEpoch: 0,
  refreshTimer: null,
  scrollPositions: new Map(),
  openDisclosures: new Map(),
  disclosureScrollPositions: new Map(),
  schedules: [],
  // A backlog of failed follow-ups renders as one summary row until the owner
  // expands it; the flag survives the 3-second refresh.
  // 一堆失败跟进在所有者展开前显示为一行摘要；该标记跨越 3 秒刷新保留。
  opportunitiesExpanded: false,
  settings: null,
  toolsCatalog: null,
  toolsLoading: false,
  toolsProbe: [],
  gateways: [],
  gatewayLoading: false,
  situation: null,
  config: null,
  connectors: [],
  authority: null,
  authorityDecisions: [],
  authorityLoading: false,
  exportDestination: null,
  whatsapp: null,
  whatsappLoading: false,
  whatsappDirty: false,
  modelOptions: [],
  modelOptionsLoaded: false,
  modelOptionsLoading: false,
  // The model/effort saved with each conversation, as served by the daemon.
  // 守护进程返回的、每个对话保存的模型/强度。
  turnChoices: {},
  memories: [],
  settingsSection: "agents",
  locale: "zh-CN",
  strings: {},
  attachments: [],
  attachmentsPending: [],
  attachmentsPreparing: 0,
  attachmentsPreparingSince: 0,
  refreshing: false,
  // The subagent row a click asked to see, until its record renders. Starting
  // there — rather than at the top of the record — is what "jump into it" means.
  // 点击要求查看的子 Agent 行，直到它的记录渲染出来。从那里而不是记录顶部开始，
  // 才是"跳转进去"的意思。
  agentFocus: null,
  // The tools settings page shows one of three: the list, one server's tools,
  // or one marketplace entry's install form. A jump replaces the list; the
  // back control returns to it.
  // 工具设置页只显示三种之一：列表、某个服务器的工具、或某个市场条目的安装表单。
  // 跳转会替换列表，返回控件回到列表。
  toolsStack: [],
  toolsRegistry: [],
  toolsMarketResults: [],
  toolsMarketTotal: 0,
  toolsMarketQuery: "",
  toolsMarketLoading: false,
  toolsMarketLoaded: false,
  toolsMarketError: null,
  skillsRegistry: [],
  skillsMarketResults: [],
  skillsMarketTotal: 0,
  skillsMarketQuery: "",
  skillsMarketLoading: false,
  skillsMarketLoaded: false,
  skillsMarketError: null,
  skillDetails: new Map(),
  toolsListScroll: 0,
};
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_CHARS = 50_000;
const MAX_TOTAL_DOCUMENT_CHARS = 100_000;
// Files are independent; a video frame no longer blocks the images and text
// behind it. Three readers keep a strong machine busy without decoding four
// large photos at once.
// 文件彼此独立；视频抽帧不再挡住后面的图片与文本。三路读取让强劲的机器保持忙碌，
// 又不会同时解码四张大照片。
const ATTACHMENT_PREPARE_CONCURRENCY = 3;
// The chip is 76 px wide and the live card 120 px; 240 px covers both at 2x DPR.
// chip 宽 76px，实时卡片 120px；240px 在 2x DPR 下同时覆盖两者。
const ATTACHMENT_THUMBNAIL_SIZE = 240;
const attachmentPreviewUrls = new Set();
// One global limiter, not one per batch: two overlapping pastes must not decode
// six photos at once. The waiting queue hands a freed slot to the next task.
// 全局只有一个限流器，而不是每个批次一个：两次重叠的粘贴不能同时解码六张照片。等待队列
// 把释放的槽位交给下一个任务。
const attachmentPrepareSlots = { active: 0, waiting: [] };
let attachmentBatch = Promise.resolve();
let attachmentBatchSequence = 0;

function takeAttachmentPrepareSlot() {
  if (attachmentPrepareSlots.active < ATTACHMENT_PREPARE_CONCURRENCY) {
    attachmentPrepareSlots.active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => attachmentPrepareSlots.waiting.push(resolve));
}

function releaseAttachmentPrepareSlot() {
  const next = attachmentPrepareSlots.waiting.shift();
  if (next !== undefined) next();
  else attachmentPrepareSlots.active = Math.max(0, attachmentPrepareSlots.active - 1);
}
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOC_MIME = "application/msword";
const TEXT_EXTENSIONS = new Set([
  "txt", "text", "md", "markdown", "mdx", "rst", "adoc", "tex",
  "csv", "tsv", "json", "jsonl", "ndjson", "yaml", "yml", "toml", "xml", "html", "htm",
  "css", "scss", "less", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "go", "rs",
  "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash",
  "zsh", "fish", "sql", "log", "ini", "cfg", "conf", "env", "diff", "patch", "graphql",
  "gql", "proto", "make", "mk",
]);
const documentIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/></svg>`;

function attachmentDocumentCharacters() {
  return state.attachments.reduce((total, item) => total + (item.kind === "document" ? item.text.length : 0), 0);
}

function shortName(name, limit = 22) {
  const value = String(name ?? "");
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderAttachments() {
  const host = $("attachment-preview");
  if (!host) return;
  const pending = state.attachmentsPending;
  host.hidden = state.attachments.length === 0 && pending.length === 0;
  const prepared = state.attachments.map((item, index) => {
    const remove = `<button type="button" data-remove-attachment="${index}" aria-label="移除附件">×</button>`;
    if (item.kind === "document" || item.kind === "binary-document") {
      return `<div class="attachment-chip document" title="${escape(item.name)}"><div class="attachment-doc">${documentIcon}<div class="attachment-doc-text"><b>${escape(shortName(item.name))}</b><small>${escape(formatBytes(item.size))}</small></div></div>${remove}</div>`;
    }
    return `<div class="attachment-chip" title="${escape(item.name)}"><img src="${item.previewUrl}" alt="${escape(item.name)}" />${remove}</div>`;
  }).join("");
  // A chip appears before the bytes are read, so a video or a slow disk never
  // leaves the composer looking as if nothing was selected.
  // 先出现 chip、后读字节，因此视频或慢速磁盘不会让输入框看起来什么都没选中。
  const preparing = pending.map((item) => `<div class="attachment-chip document is-preparing" title="${escape(item.name)}"><div class="attachment-doc">${documentIcon}<div class="attachment-doc-text"><b>${escape(shortName(item.name))}</b><small>读取中…</small></div></div></div>`).join("");
  host.innerHTML = prepared + preparing;
}

function trackAttachmentPreview(url) {
  if (typeof url === "string" && url.startsWith("blob:")) attachmentPreviewUrls.add(url);
  return url;
}

function releaseAttachmentPreview(item) {
  const url = item?.previewUrl;
  if (typeof url !== "string" || !url.startsWith("blob:")) return;
  attachmentPreviewUrls.delete(url);
  URL.revokeObjectURL(url);
}

function releaseAttachmentPreviews(items) {
  for (const item of items) releaseAttachmentPreview(item);
}

/**
 * The live card uses the same blob URLs as the composer. Once a refresh has
 * replaced that card with the persisted log, the URLs have no reader left.
 * 实时卡片与输入框共用同一批 blob URL。刷新用持久化日志替换卡片后，这些 URL 已无读者。
 */
function releaseReplacedAttachmentPreviews(card, items) {
  if (card.isConnected) return;
  // A failed send can restore these same items to the composer; their URLs
  // still have a reader there.
  // 发送失败可能把这些条目恢复回输入框；它们的 URL 在那里仍有读者。
  if (items.some((item) => state.attachments.includes(item))) return;
  releaseAttachmentPreviews(items);
}

/**
 * A failed send puts the original attachments back in front of anything the
 * owner attached during the turn, never exceeding the four-file cap.
 * 发送失败时把原附件放回失败回合期间新加附件的前面，且绝不超过四附件上限。
 */
function mergeRestoredAttachments(outgoing, current) {
  const room = Math.max(0, MAX_ATTACHMENTS - current.length);
  const restored = outgoing.filter((item) => !current.includes(item)).slice(0, room);
  return restored.length === 0 ? current : [...restored, ...current];
}

/**
 * A 4K photo decoded at full resolution for a 76 px chip costs tens of
 * megabytes and makes the next paint wait. Decode one 240 px JPEG instead;
 * the original File is still what the send reads, so the model keeps the
 * full-resolution bytes.
 * 4K 照片按原始分辨率解码到 76px chip 要花几十 MB，并拖慢下一次绘制。改为只解码一张
 * 240px JPEG；发送读的仍是原始 File，模型拿到的还是全分辨率字节。
 */
async function imagePreviewUrl(file) {
  const original = trackAttachmentPreview(URL.createObjectURL(file));
  if (typeof globalThis.createImageBitmap !== "function") return original;
  let bitmap;
  try {
    bitmap = await globalThis.createImageBitmap(file, { resizeWidth: ATTACHMENT_THUMBNAIL_SIZE, resizeQuality: "medium" });
  } catch {
    return original;
  }
  try {
    const scale = Math.min(1, ATTACHMENT_THUMBNAIL_SIZE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob) return original;
    attachmentPreviewUrls.delete(original);
    URL.revokeObjectURL(original);
    return trackAttachmentPreview(URL.createObjectURL(blob));
  } catch {
    return original;
  } finally {
    bitmap.close?.();
  }
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取附件失败。"));
    reader.readAsDataURL(file);
  });
}

function readText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取附件失败。"));
    reader.readAsText(file);
  });
}

function extensionOf(name) {
  const match = String(name ?? "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

function isTextDocumentFile(file) {
  const extension = extensionOf(file.name);
  // `.ts` is TypeScript and MPEG transport stream at the same time; macOS may
  // report the video type for a source file. The extension wins for that pair
  // so a source file is not handed to the video-frame decoder.
  // `.ts` 同时是 TypeScript 与 MPEG transport stream；macOS 可能把源码报成视频类型。
  // 对这对冲突让扩展名优先，避免把源码交给视频抽帧器。
  if (TEXT_EXTENSIONS.has(extension) && (file.type === "video/mp2t" || file.type === "application/x-typescript")) return true;
  if (file.type.length > 0) {
    return /^text\/[a-z0-9.+-]+$/.test(file.type)
      || /^application\/(json|xml|xhtml\+xml|javascript|x-javascript|sql|x-yaml|yaml|toml|x-httpd-php)$/.test(file.type);
  }
  return TEXT_EXTENSIONS.has(extension);
}

function documentMimeType(file) {
  if ((file.type.startsWith("text/") || /^application\/(json|xml|xhtml\+xml|javascript|x-javascript|sql|x-yaml|yaml|toml|x-httpd-php)$/.test(file.type)) && file.type.length > 0) return file.type;
  const extension = extensionOf(file.name);
  if (extension === "md" || extension === "markdown" || extension === "mdx") return "text/markdown";
  if (extension === "json" || extension === "jsonl" || extension === "ndjson") return "application/json";
  if (extension === "csv" || extension === "tsv") return "text/csv";
  return "text/plain";
}

function binaryDocumentKind(file) {
  const extension = extensionOf(file.name);
  const genericType = file.type.length === 0 || file.type === "application/octet-stream" || file.type === "application/zip";
  if (file.type === "application/pdf" || (genericType && extension === "pdf")) return "pdf";
  if (file.type === DOCX_MIME || (genericType && extension === "docx")) return "docx";
  if (file.type === DOC_MIME || (genericType && extension === "doc")) return "doc";
  return undefined;
}

function looksBinaryText(text) {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text);
}

/**
 * The native shell extracts a frame with AVFoundation for videos chosen through
 * its picker; that is ~150 ms instead of the WebView media pipeline's ~1.1 s.
 * Drag/drop, paste, a missing bridge or a failed extraction fall back to the
 * HTML video path below.
 * 原生外壳对通过其选择器选中的视频用 AVFoundation 抽帧，约 150ms，而 WebView 媒体管线约
 * 1.1s。拖放、粘贴、缺少桥接或抽取失败时，回退到下面的 HTML video 路径。
 */
async function nativeVideoFrame(file) {
  const native = typeof window === "object" ? window.CloneNative : undefined;
  if (typeof native?.videoFrame !== "function") return undefined;
  try {
    const dataUrl = await native.videoFrame(`${file.name}:${file.size}`);
    return typeof dataUrl === "string" && dataUrl.startsWith("data:image/") ? dataUrl : undefined;
  } catch {
    return undefined;
  }
}

async function videoFrame(file) {
  const native = await nativeVideoFrame(file);
  if (native !== undefined) {
    return { kind: "image", name: `${file.name}（视频帧）`, mimeType: "image/jpeg", data: native.slice(native.indexOf(",") + 1), previewUrl: native };
  }
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error("无法读取视频。"));
      video.load();
    });
    video.currentTime = Math.min(1, Math.max(0.05, (video.duration || 1) / 3));
    await new Promise((resolve, reject) => {
      video.onseeked = resolve;
      video.onerror = () => reject(new Error("无法提取视频画面。"));
    });
    const scale = Math.min(1, 1280 / Math.max(1, video.videoWidth));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const previewUrl = canvas.toDataURL("image/jpeg", 0.86);
    return { kind: "image", name: `${file.name}（视频帧）`, mimeType: "image/jpeg", data: previewUrl.split(",")[1], previewUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Validates and prepares one selected file. Reads happen here, concurrently;
 * the capacity and shared-budget checks stay in input order in
 * `addAttachmentFilesNow`, where earlier results are already known.
 * 校验并准备一个选中的文件。读取在这里并发发生；容量与共享预算检查仍按输入顺序留在
 * `addAttachmentFilesNow` 中，那里已经知道前面结果的长度。
 */
async function prepareAttachment(file) {
  try {
    if (isTextDocumentFile(file)) {
      if (file.size > MAX_DOCUMENT_BYTES) return { rejected: `${file.name} 超过 2MB。` };
      const text = await readText(file);
      if (text.length === 0) return { rejected: `${file.name} 是空文件。` };
      if (text.length > MAX_DOCUMENT_CHARS) return { rejected: `${file.name} 超过 ${MAX_DOCUMENT_CHARS} 字符。` };
      if (looksBinaryText(text)) return { rejected: `${file.name} 看起来不是文本文件。` };
      return { item: { kind: "document", name: file.name, mimeType: documentMimeType(file), text, size: file.size } };
    }
    const binaryKind = binaryDocumentKind(file);
    if (binaryKind !== undefined) {
      if (file.size > MAX_BINARY_DOCUMENT_BYTES) return { rejected: `${file.name} 超过 10MB。` };
      // The chip only needs a name and size; the bytes are read in the
      // background after the chip exists.
      // chip 只需要名称与大小；字节在 chip 出现后于后台读取。
      return { item: { kind: "binary-document", name: file.name, mimeType: binaryKind === "pdf" ? "application/pdf" : binaryKind === "docx" ? DOCX_MIME : DOC_MIME, file, size: file.size } };
    }
    if (file.type.startsWith("video/")) return { item: await videoFrame(file) };
    if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
      if (file.size > MAX_ATTACHMENT_BYTES) return { rejected: `${file.name} 超过 5MB。` };
      return { item: { kind: "image", name: file.name, mimeType: file.type, file, previewUrl: await imagePreviewUrl(file), size: file.size } };
    }
    return { rejected: "只支持图片、视频、文本类文档与 PDF/.docx。" };
  } catch (error) {
    return { rejected: error instanceof Error ? error.message : "附件读取失败。" };
  }
}

/**
 * Starts up to `limit` preparations ahead of the consumer and returns their
 * promises in input order. `stop()` prevents new work once the four-attachment
 * cap is reached; in-flight reads finish and are released by the caller.
 * 在消费者之前最多启动 `limit` 个准备任务，并按输入顺序返回它们的 Promise。达到四附件
 * 上限后 `stop()` 阻止新任务；在途读取会完成，由调用方释放。
 */
function prefetchAttachments(files, limit) {
  const outcomes = new Array(files.length);
  let next = 0;
  let active = 0;
  let stopped = false;
  const pump = () => {
    while (!stopped && active < limit && next < files.length) {
      const index = next;
      next += 1;
      active += 1;
      outcomes[index] = Promise.resolve()
        .then(async () => {
          await takeAttachmentPrepareSlot();
          try {
            return stopped ? undefined : await prepareAttachment(files[index]);
          } finally {
            releaseAttachmentPrepareSlot();
          }
        })
        .catch((error) => ({ rejected: error instanceof Error ? error.message : "附件读取失败。" }))
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };
  pump();
  return { outcomes, stop: () => { stopped = true; } };
}

function beginAttachmentPlaceholders(files) {
  const batch = attachmentBatchSequence + 1;
  attachmentBatchSequence = batch;
  const slots = Math.max(0, MAX_ATTACHMENTS - state.attachments.length - state.attachmentsPending.length);
  state.attachmentsPending.push(...files.slice(0, slots).map((file, index) => ({ batch, index, name: file.name, size: file.size })));
  renderAttachments();
  return batch;
}

function resolveAttachmentPlaceholder(batch, index) {
  const before = state.attachmentsPending.length;
  state.attachmentsPending = state.attachmentsPending.filter((item) => !(item.batch === batch && item.index === index));
  if (state.attachmentsPending.length !== before) renderAttachments();
}

function endAttachmentPlaceholders(batch) {
  state.attachmentsPending = state.attachmentsPending.filter((item) => item.batch !== batch);
  renderAttachments();
}

async function addAttachmentFilesNow(files) {
  const list = Array.from(files);
  if (list.length === 0) return 0;
  if (state.attachments.length >= MAX_ATTACHMENTS) { announce(`最多添加 ${MAX_ATTACHMENTS} 个附件。`, true); return 0; }
  const batch = beginAttachmentPlaceholders(list);
  const { outcomes, stop } = prefetchAttachments(list, ATTACHMENT_PREPARE_CONCURRENCY);
  let added = 0;
  try {
    for (let index = 0; index < list.length; index += 1) {
      if (state.attachments.length >= MAX_ATTACHMENTS) { announce(`最多添加 ${MAX_ATTACHMENTS} 个附件。`, true); stop(); break; }
      const outcome = await outcomes[index];
      resolveAttachmentPlaceholder(batch, index);
      if (outcome === undefined) continue;
      if (outcome.rejected !== undefined) { announce(outcome.rejected, true); continue; }
      // Another batch can finish while this one awaited; re-check before the
      // push so two overlapping selections cannot exceed four.
      // 另一个批次可能在本批次等待时完成；push 前再检查一次，避免两个重叠的选择超过四个。
      if (state.attachments.length >= MAX_ATTACHMENTS) { announce(`最多添加 ${MAX_ATTACHMENTS} 个附件。`, true); stop(); break; }
      const item = outcome.item;
      if (item.kind === "document" && attachmentDocumentCharacters() + item.text.length > MAX_TOTAL_DOCUMENT_CHARS) {
        announce(`文档合计超过 ${MAX_TOTAL_DOCUMENT_CHARS} 字符。`, true);
        continue;
      }
      state.attachments.push(item);
      added += 1;
      prefetchAttachmentPayload(item);
      renderAttachments();
    }
  } finally {
    endAttachmentPlaceholders(batch);
    // A file prepared after the cap was reached is never shown; release its
    // preview URL instead of leaving a blob behind.
    // 达到上限后才准备好的文件不会显示；释放它的预览 URL，避免留下 blob。
    for (const outcome of outcomes) {
      Promise.resolve(outcome).then((result) => {
        if (result?.item !== undefined && !state.attachments.includes(result.item)) releaseAttachmentPreview(result.item);
      }).catch(() => undefined);
    }
  }
  renderAttachments();
  return added;
}

/**
 * Adds files as one tracked batch. The composer clears immediately; `createSession`
 * awaits the latest batch so a file can never land in the next message.
 * 把文件作为一条被跟踪的批次加入。输入框立即清空；`createSession` 会等待最新批次，
 * 文件因此不可能落到下一条消息里。
 */
function addAttachmentFiles(files) {
  state.attachmentsPreparing += 1;
  if (state.attachmentsPreparing === 1) state.attachmentsPreparingSince = performance.now();
  const work = addAttachmentFilesNow(files)
    .catch((error) => { announce(error instanceof Error ? error.message : "附件读取失败。", true); return 0; })
    .finally(() => {
      state.attachmentsPreparing = Math.max(0, state.attachmentsPreparing - 1);
      if (state.attachmentsPreparing === 0) state.attachmentsPreparingSince = 0;
    });
  attachmentBatch = attachmentBatch.then(() => work, () => work);
  return work;
}

/**
 * Encodes one attachment for the request. Images and binary documents are read
 * here, not at selection; `toBase64` avoids the intermediate data-URL string
 * where the runtime provides it.
 * 为请求编码一个附件。图片与二进制文档在这里读取，而不是在选择时；运行时提供
 * `toBase64` 时，省掉中间的 data URL 字符串。
 */
async function readAttachmentBase64(file) {
  if (typeof Uint8Array.prototype.toBase64 === "function") {
    try {
      return new Uint8Array(await file.arrayBuffer()).toBase64();
    } catch {
      // Fall through to FileReader on runtimes with a partial implementation.
      // 运行时的实现不完整时回退到 FileReader。
    }
  }
  const dataUrl = await readDataUrl(file);
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

async function attachmentPayload(item) {
  try {
    if (item.kind === "document") return { kind: "document", name: item.name, mimeType: item.mimeType, text: item.text };
    if (item.kind === "binary-document") {
      return { kind: "document", name: item.name, mimeType: item.mimeType, data: await readAttachmentBase64(item.file) };
    }
    if (item.file !== undefined) return { kind: "image", mimeType: item.mimeType, data: await readAttachmentBase64(item.file) };
    return { kind: "image", mimeType: item.mimeType, data: item.data };
  } catch (error) {
    throw new Error(`${item.name || "附件"}：${error instanceof Error ? error.message : "读取失败"}`);
  }
}

/**
 * Starts encoding an accepted attachment in the background. The chip already
 * exists, so this read does not delay the click; a send that arrives before it
 * finishes simply awaits it. Keeping the promise on the item also means a
 * failed send restored for retry reuses the encoded bytes instead of rereading.
 * 在后台开始编码一个已接受的附件。chip 已经存在，这次读取不拖慢点击；在它完成前发送，
 * 只会等待它。Promise 留在条目上，因此失败后恢复重试也会复用已编码的字节，而不是重读。
 */
function prefetchAttachmentPayload(item) {
  item.payload ??= attachmentPayload(item).then(
    (attachment) => ({ ok: true, attachment }),
    (error) => {
      // A transient read failure must stay retryable; do not pin the rejection
      // to the item, or every later send fails without rereading the file.
      // 瞬时读取失败必须可以重试；不要把拒绝钉在条目上，否则之后每次发送都会失败而不重读文件。
      delete item.payload;
      return { ok: false, error: error instanceof Error ? error.message : "附件读取失败。" };
    },
  );
  return item.payload;
}

/** Encodes every attachment concurrently; success and failure are returned, not thrown. 并发编码全部附件；成功与失败以返回值表示。 */
async function attachmentsForRequest(items) {
  const settled = await Promise.all(items.map((item) => prefetchAttachmentPayload(item)));
  const failed = settled.find((result) => !result.ok);
  if (failed !== undefined) return { ok: false, error: failed.error };
  return { ok: true, attachments: settled.map((result) => result.attachment) };
}

/**
 * Rebuild File objects from the native clipboard reader. The page never passes
 * a path: the shell reads the pasteboard's own file URLs, and this helper only
 * turns the bytes it returned into the same File shape the attachment pipeline
 * already accepts.
 * 从原生剪贴板读取器重建 File。页面不传路径：外壳读取剪贴板自身的文件 URL，这里只把它
 * 返回的字节变成附件管线已经接受的同一种 File。
 */
function filesFromNativePayloads(payloads) {
  const files = [];
  for (const payload of Array.isArray(payloads) ? payloads : []) {
    if (typeof payload?.data !== "string" || typeof payload?.name !== "string" || payload.name.length === 0) continue;
    try {
      const binary = globalThis.atob(payload.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const file = new File([bytes], payload.name, { type: typeof payload.mimeType === "string" ? payload.mimeType : "" });
      file.clonePath = typeof payload.path === "string" ? payload.path : "";
      files.push(file);
    } catch {
      // A malformed payload is skipped; its path still falls back to text. 畸形载荷跳过；它的路径仍回退为文本。
    }
  }
  return files;
}

function clipboardAttachmentFiles(clipboardData, options = {}) {
  if (!clipboardData) return [];
  const preserve = options?.preserve instanceof Set ? options.preserve : undefined;
  const files = [];
  const add = (file) => {
    if (!file || !/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return;
    const extension = file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1];
    // A clipboard image gets a stable, visible screenshot name; a Finder file
    // whose path the paste handler already knows keeps its real name.
    // 剪贴板图片获得稳定、可见的截图名；粘贴处理器已经知道路径的 Finder 文件保留真实名称。
    const name = preserve?.has(file.name) ? file.name : `剪贴板截图-${files.length + 1}.${extension}`;
    files.push(new File([file], name, { type: file.type }));
  };

  for (let index = 0; index < (clipboardData.items?.length || 0); index += 1) {
    const item = clipboardData.items[index];
    if (item?.kind === "file" && item.type.startsWith("image/")) add(item.getAsFile());
  }
  if (files.length === 0) {
    for (let index = 0; index < (clipboardData.files?.length || 0); index += 1) add(clipboardData.files[index]);
  }
  return files;
}

/**
 * Every File on the clipboard, images and documents alike. The image-only
 * helper above keeps the screenshot path unchanged; this one exists because a
 * Finder copy of a .md/.pdf used to fall through to WebKit's default paste,
 * which inserts the bare file names and no content.
 * 剪贴板上的所有 File，图片与文档都算。上面的只收图片的助手保持截图路径不变；这一个存在
 * 是因为 Finder 复制的 .md/.pdf 以前会落到 WebKit 默认粘贴，只插入裸文件名、没有内容。
 */
function clipboardFileObjects(clipboardData) {
  if (!clipboardData) return [];
  const files = [];
  const add = (file) => {
    if (file && !files.includes(file)) files.push(file);
  };
  for (let index = 0; index < (clipboardData.items?.length || 0); index += 1) {
    const item = clipboardData.items[index];
    if (item?.kind === "file") add(item.getAsFile());
  }
  if (files.length === 0) {
    for (let index = 0; index < (clipboardData.files?.length || 0); index += 1) add(clipboardData.files[index]);
  }
  return files;
}

const IMAGE_PATH_PATTERN = /\.(?:png|jpe?g|gif|webp)$/i;

function basenameOfPath(path) {
  const parts = String(path).split("/");
  return parts[parts.length - 1] || String(path);
}

/**
 * The native shell publishes the file paths on the clipboard whenever the app
 * becomes active. Reading that cache synchronously is what lets the paste
 * handler call preventDefault before any await, so the browser never inserts
 * the bare names first.
 * 原生外壳在 App 激活时发布剪贴板中的文件路径。同步读取这份缓存，粘贴处理器才能在任何
 * await 之前调用 preventDefault，浏览器因此不会先把裸文件名插进去。
 */
function cachedClipboardFilePaths() {
  const cached = window.CloneNative?.clipboardFilePaths;
  return Array.isArray(cached) ? cached.filter((path) => typeof path === "string" && path.length > 0) : [];
}

function clearCachedClipboardFilePaths() {
  if (window.CloneNative) window.CloneNative.clipboardFilePaths = [];
}

async function refreshClipboardFilePaths() {
  if (typeof window.CloneNative?.filePathsForPaste !== "function") return;
  try {
    const paths = await window.CloneNative.filePathsForPaste();
    if (Array.isArray(paths)) window.CloneNative.clipboardFilePaths = paths.filter((path) => typeof path === "string" && path.length > 0);
  } catch {
    // The browser preview has no native bridge. 浏览器预览没有原生桥接。
  }
}

/**
 * Read the files currently on the native pasteboard as File objects. The shell
 * only reads the pasteboard's own URLs, so this cannot be turned into a generic
 * path reader from page JavaScript.
 * 把原生剪贴板当前的文件读成 File。外壳只读剪贴板自身的 URL，因此页面 JavaScript 无法
 * 把它变成通用的路径读取器。
 */
async function nativeClipboardFiles() {
  if (typeof window.CloneNative?.readClipboardFiles !== "function") return [];
  try {
    return filesFromNativePayloads(await window.CloneNative.readClipboardFiles());
  } catch {
    return [];
  }
}

/**
 * Insert text at the caret. execCommand keeps the native undo stack; the
 * setRangeText fallback still delivers the text where the owner was typing.
 * 在光标处插入文本。execCommand 保留原生撤销栈；setRangeText 回退仍把文本放在所有者打字的位置。
 */
function insertComposerText(text) {
  const query = $("query");
  if (query === null || text.length === 0) return;
  const start = query.selectionStart ?? query.value.length;
  const end = query.selectionEnd ?? start;
  const before = query.value.slice(0, start);
  const after = query.value.slice(end);
  const insertion = `${before.length > 0 && !/\s$/.test(before) ? "\n" : ""}${text}${after.length === 0 || !/^\s/.test(after) ? "\n" : ""}`;
  query.focus();
  query.setSelectionRange(start, end);
  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, insertion);
  } catch {
    inserted = false;
  }
  if (!inserted) {
    query.setRangeText(insertion, start, end, "end");
    query.dispatchEvent(new Event("input", { bubbles: true }));
  }
  resizeComposer();
}
const icon = (name) => name === "spark"
  ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 2 1.8 7.2L21 11l-7.2 1.8L12 20l-1.8-7.2L3 11l7.2-1.8L12 2Z"/></svg>`
  : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>`;
const escape = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
function plainPreview(value) {
  return String(value ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)([^*_\n]+)\1/g, "$2")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
const t = (key) => (state.strings && state.strings[key]) || key;
function notifyDesktopNavigation(section) {
  try {
    window.webkit?.messageHandlers?.cloneNavigation?.postMessage(section);
  } catch {
    // Browser previews do not have the native navigation bridge.
    // 浏览器预览没有原生导航桥接。
  }
}
const time = (value) => new Intl.DateTimeFormat(state.locale || "zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
const day = (value) => new Intl.DateTimeFormat(state.locale || "zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date(value));
function applyChrome(locale, strings) {
  const next = strings || {};
  const nextLocale = locale || "zh-CN";
  const changed = state.locale !== nextLocale || JSON.stringify(state.strings) !== JSON.stringify(next);
  // The 3-second refresh calls this with the same config every time. Rewriting
  // every [data-i18n] node when nothing changed invalidates layout under a
  // click, so leave the DOM alone.
  // 3 秒刷新每次都带同一份配置调用这里。没有变化时重写每个 [data-i18n] 节点会在点击
  // 之下让布局失效，因此不要碰 DOM。
  if (!changed) return;
  state.locale = nextLocale;
  state.strings = next;
  document.documentElement.lang = state.locale;
  document.title = t("title");
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    const key = node.getAttribute("data-i18n");
    if (!key) return;
    const attr = node.getAttribute("data-i18n-attr");
    const value = t(key);
    if (attr) node.setAttribute(attr, value);
    else node.textContent = value;
  });
  const query = $("query");
  if (query) query.setAttribute("aria-label", t("query-label"));
  const marketSearch = $("tools-market-search");
  if (marketSearch) marketSearch.setAttribute("aria-label", t("tools-market-search-label"));
  const localeSelect = $("config-locale");
  if (localeSelect && document.activeElement !== localeSelect) localeSelect.value = state.locale;
  state.signatures = {};
  // The picker labels are localized now; rebuild the option text for the new
  // language without touching a focused select's selection.
  // 选择器的标签现在已本地化；为新语言重建选项文本，同时不动正在聚焦的选择器的选中值。
  renderComposerChoice();
  // Marketplace cards and a detail page carry registry text in the chosen
  // language; rebuild them rather than leaving a half-translated page.
  // 市场卡片与详情页带有所选语言的清单文本；重建它们，避免留下半翻译的页面。
  if (state.toolsCatalog) renderToolsCatalog(state.toolsCatalog);
  if (state.toolsStack.length > 0) renderToolsDetail();
}
const api = async (path, options = {}) => {
  const headers = new Headers(options.headers);
  if (window.CLONE_AI_TOKEN) headers.set("x-clone-ai-token", window.CLONE_AI_TOKEN);
  const response = await fetch(path, { ...options, headers });
  const body = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(body.error || t("local-request-failed"));
  return body;
};
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 520;
let sidebarResizeActive = false;
function applySidebarWidth(value, persist = true) { const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - 400)); const width = Math.round(Math.max(SIDEBAR_MIN, Math.min(max, value))); document.documentElement.style.setProperty("--sidebar-width", `${width}px`); document.querySelector(".app-shell").style.setProperty("--sidebar-width", `${width}px`); const handle = $("sidebar-resizer"); handle.setAttribute("aria-valuenow", String(width)); if (persist) localStorage.setItem("clone-ai:sidebar-width", String(width)); }
function restoreSidebarWidth() { const saved = Number(localStorage.getItem("clone-ai:sidebar-width")); applySidebarWidth(Number.isFinite(saved) ? saved : 278, false); }
// Evidence kinds the runtime records, in the owner's language. 运行时记录的证据类型，用所有者的语言。
const EVIDENCE_KIND = { artifact: "产物", observation: "观察", tool_result: "工具结果", receipt: "回执", test: "测试" };
const statusMeta = (status) => {
  if (status === "waiting_approval") return { label: t("status-waiting"), className: "waiting", dot: "owner" };
  if (status === "waiting_review") return { label: t("status-review"), className: "waiting", dot: "owner" };
  if (status === "completed") return { label: t("status-completed"), className: "completed", dot: "completed" };
  if (status === "failed" || status === "cancelled") return { label: t("status-needs-attention"), className: "needs-attention", dot: "needs-attention" };
  return { label: t("status-running"), className: "running", dot: "running" };
};
function announce(message, error = false) { const node = $("notice"); node.textContent = message; node.className = `notice visible${error ? " error" : ""}`; clearTimeout(node.timer); node.timer = setTimeout(() => node.className = "notice", 3200); }
function mintConversationId() {
  // A readable prefix keeps a task id distinguishable from a run UUID in logs;
  // the server decides conversation-versus-run from the ledger, not from the name.
  // 可读的前缀让任务 id 在日志里能与 Run UUID 区分；服务端靠台账而不是名字判断它是对话还是 Run。
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `conversation-${suffix}`;
}
const sessionTime = (session) => Date.parse(session.updatedAt) || 0;
function sessionMarkup(session, options = {}) {
  const status = statusMeta(session.status);
  // The main conversation has a fixed name and no hide control: its content
  // title would churn every turn, and it is the one thread the sidebar always
  // keeps. Every other conversation is named by its first request.
  // 主对话使用固定名称且没有隐藏控件：内容标题会每回合变化，而且它是侧栏始终保留的唯一
  // 线程。其他对话由第一个请求命名。
  const main = options.main === true;
  const preview = plainPreview(session.preview);
  const metaText = options.context
    ? `${options.context} · ${preview || status.label}`
    : main && !preview ? t("main-conversation-legacy") : preview || status.label;
  // Waiting for the owner is a state, not a footnote: a task that needs a
  // decision says so in the row, not only in its preview text.
  // 等待所有者是一种状态，不是脚注：需要决定的任务在行内明说，而不只写在预览里。
  const flag = session.status === "waiting_approval"
    ? `<span class="session-flag session-flag-approval">${escape(t("session-flag-approval"))}</span>`
    : session.status === "waiting_review"
      ? `<span class="session-flag session-flag-review">${escape(t("session-flag-review"))}</span>`
      : "";
  const needs = session.status === "waiting_approval" || session.status === "waiting_review";
  const conversation = session.kind === "conversation";
  const classes = `session-item${needs ? " is-attention" : ""}${conversation ? " is-conversation" : ""}`;
  // A row is a conversation, except for the one task that needs the owner: it
  // is promoted into 需要你处理 because a decision that is invisible is a
  // decision missed. Everything else a turn dispatched is read in the audit.
  // 行就是对话；唯一的例外是需要所有者决定的任务：它被提升到 需要你处理，因为看不见的
  // 决定等于漏掉的决定。回合派发的其他东西都在审计里读。
  const deleteLabel = conversation ? "隐藏这个对话" : "隐藏这条任务";
  const deleteControl = main
    ? ""
    : `<button class="session-delete" type="button" data-delete-session="${escape(session.id)}" aria-label="${deleteLabel}">×</button>`;
  const title = main ? t("session-group-main") : plainPreview(session.title);
  return `<div class="${classes}"><button class="session" type="button" data-session="${escape(session.id)}" aria-current="${String(session.id === state.selectedId)}"><span class="status-dot ${status.dot}"></span><span class="session-copy"><span class="session-title-row"><span class="session-title">${escape(title)}</span>${flag}</span><span class="session-meta">${escape(metaText)}</span></span></button>${deleteControl}</div>`;
}
function renderSessions(rawSessions) {
  // The sidebar lists conversations and nothing else. The Runs a turn
  // dispatched are read in 设置 → 审计与轨迹: nesting them here turned the
  // sidebar into a process log, and two runs with similar titles were
  // indistinguishable. A task waiting for the owner is the one exception — it
  // is promoted into 需要你处理, because a decision that is invisible is a
  // decision missed. The main conversation is the pinned first row rather than
  // a second navigation control.
  // 侧栏只列对话，别的都不列。回合派发的 Run 在 设置 → 审计与轨迹 里读：把它们嵌套在这里
  // 会让侧栏变成过程日志，两条标题相近的 Run 无法区分。唯一例外是等待所有者决定的任务——
  // 它被提升到 需要你处理，因为看不见的决定等于漏掉的决定。主对话是固定的第一行，而不是
  // 第二个导航控件。
  const conversations = rawSessions.filter((session) => session.kind === "conversation");
  const mainConversation = conversations.find((session) => session.id === MAIN_CONVERSATION_ID);
  const otherConversations = conversations.filter((session) => session.id !== MAIN_CONVERSATION_ID);
  const tasks = rawSessions.filter((session) => session.kind !== "conversation");
  const conversationById = new Map(conversations.map((session) => [session.id, session]));
  const needsOwner = (session) => session.status === "waiting_approval" || session.status === "waiting_review";
  const byTime = (left, right) => sessionTime(right) - sessionTime(left);
  const waitingTasks = tasks.filter(needsOwner).sort(byTime);
  const parentLabel = (task) => {
    if (task.parentId === MAIN_CONVERSATION_ID) return t("session-group-main");
    const parent = task.parentId === undefined ? undefined : conversationById.get(task.parentId);
    return parent ? shortName(plainPreview(parent.title), 24) : t("session-group-auto");
  };
  const ordered = [...otherConversations].sort(byTime);
  // Count what the owner can see: conversations plus the decisions waiting for
  // them. A dispatched run that needs nothing from the owner is not a row.
  // 计数是所有者能看到的东西：对话加上等待他决定的任务。不需要所有者做任何事的派发 Run
  // 不是一行。
  const total = ordered.length + (mainConversation === undefined ? 0 : 1) + waitingTasks.length;
  $("session-count").textContent = String(total);
  const signature = JSON.stringify([
    state.selectedId,
    rawSessions.map((session) => [
      session.id, session.title, session.preview, session.status,
      session.updatedAt, session.kind, session.parentId,
    ]),
    state.dashboard?.deletedConversations,
  ]);
  if (state.signatures.sessions === signature) return;
  state.signatures.sessions = signature;
  const deleted = state.dashboard?.deletedConversations || [];
  // An empty visible list is not an empty sidebar: a hidden conversation still
  // needs its restore control, so the shortcut only applies when nothing is
  // hidden either. 可见列表为空不等于侧栏为空：隐藏的对话仍需要恢复入口，
  // 因此只有确实没有隐藏内容时才走空状态。
  if (!total && !deleted.length) { $("session-list").innerHTML = `<div class="empty-sessions">${t("empty-sessions").replace("\n", "<br/>")}</div>`; return; }
  const waitingBlock = waitingTasks.length
    ? `<div class="session-group session-group-needs">${escape(t("needs-you"))} · ${waitingTasks.length}</div>${waitingTasks.map((task) => sessionMarkup(task, { context: parentLabel(task) })).join("")}`
    : "";
  const todayKey = new Date().toDateString();
  const today = ordered.filter((session) => new Date(sessionTime(session)).toDateString() === todayKey);
  const earlier = ordered.filter((session) => new Date(sessionTime(session)).toDateString() !== todayKey);
  const mainBlock = mainConversation === undefined ? "" : sessionMarkup(mainConversation, { main: true });
  const todayBlock = today.length ? `<div class="session-group">${t("today")}</div>${today.map((session) => sessionMarkup(session)).join("")}` : "";
  const earlierBlock = earlier.length ? `<div class="session-group">${t("earlier")}</div>${earlier.map((session) => sessionMarkup(session)).join("")}` : "";
  const hidden = deleted.map((entry) => `<div class="session-item is-hidden-conversation"><span class="session-copy"><span class="session-title">${escape(entry.title)}</span><span class="session-meta">已隐藏</span></span><button class="session-restore" type="button" data-restore-conversation="${escape(entry.id)}">恢复</button></div>`).join("");
  const hiddenBlock = hidden ? `<div class="session-group">已隐藏</div>${hidden}` : "";
  $("session-list").innerHTML = `${waitingBlock}${mainBlock}${todayBlock}${earlierBlock}${hiddenBlock}`;
}
function renderSchedules(schedules, occurrences = [], reportDeliveries = [], reportError = false) {
  state.schedules = schedules;
  const signature = JSON.stringify([schedules, occurrences, reportDeliveries, reportError]);
  if (state.signatures.schedules === signature) return;
  state.signatures.schedules = signature;
  $("schedule-count").textContent = String(schedules.filter((schedule) => schedule.enabled).length);
  const rows = schedules.length ? schedules.map((schedule) => `<div class="schedule-row"><div><b>${escape(schedule.query)}</b><span>${escape(schedule.description)} · ${schedule.enabled ? t("enabled") : t("paused")}</span></div><button class="schedule-toggle" type="button" data-schedule-toggle="${escape(schedule.id)}" data-schedule-enabled="${String(!schedule.enabled)}">${schedule.enabled ? t("pause") : t("enable")}</button></div>`).join("") : `<div class="schedule-empty">${t("empty-schedules").replace("\n", "<br/>")}</div>`;
  const warnings = occurrences.map((item) => `<div class="schedule-row"><div><b>${escape(item.schedule.query)}</b><span>${escape(t("schedule-unknown"))}</span></div><div><button class="schedule-toggle" type="button" data-schedule-occurrence="${escape(item.id)}" data-resolution="retry">${escape(t("schedule-retry"))}</button><button class="schedule-toggle" type="button" data-schedule-occurrence="${escape(item.id)}" data-resolution="dismiss">${escape(t("schedule-dismiss"))}</button></div></div>`).join("");
  const reportWarnings = reportDeliveries.map((item) => `<div class="schedule-row"><div><b>${escape(t("report-unknown-title"))}</b><span>${escape(item.day)} · ${escape(t("report-unknown"))}</span></div><div><button class="schedule-toggle" type="button" data-report-day="${escape(item.day)}" data-resolution="retry">${escape(t("schedule-retry"))}</button><button class="schedule-toggle" type="button" data-report-day="${escape(item.day)}" data-resolution="dismiss">${escape(t("schedule-dismiss"))}</button></div></div>`).join("");
  const reportFailure = reportError ? `<div class="schedule-row"><div><b>${escape(t("report-state-error-title"))}</b><span>${escape(t("report-state-error"))}</span></div></div>` : "";
  $("schedule-list").innerHTML = rows + warnings + reportWarnings + reportFailure;
}
function agentRoleLabel(role) { return ({ general: t("role-general"), direct: t("role-direct"), research: t("role-research"), draft: t("role-draft"), review: t("role-review"), external: t("role-external") }[role] || role); }
function providerLabel(id) { return ({ "codex-cli": "Codex CLI", "claude-code": "Claude Code", pi: "Pi" }[id] || id); }
function renderSettings(settings) {
  state.settings = settings;
  renderAgentPage();
}
function renderGateways(gateways) {
  state.gateways = gateways;
  renderAgentPage();
  renderComposerChoice();
}
function toolsRiskLabel(risk) {
  return ({
    read: t("tools-read"),
    write: t("tools-write"),
    network: t("tools-network"),
    external: t("tools-external"),
  }[risk] || risk);
}

/** A tool's readable summary and parameters: the probe schema first, the description second. 工具的可读摘要与参数：优先探测 Schema，其次描述。 */
function toolMeta(description, schema) {
  const parsed = globalThis.CloneToolFormat?.describeTool?.(description) ?? { summary: String(description ?? ""), params: [] };
  const fromSchema = schema === undefined ? [] : globalThis.CloneToolFormat?.paramsFromSchema?.(schema) ?? [];
  return { summary: parsed.summary, params: fromSchema.length > 0 ? fromSchema : parsed.params };
}

function toolRiskBadge(risk) {
  return `<span class="tool-risk tool-risk-${escape(risk)}">${escape(toolsRiskLabel(risk))}</span>`;
}

function toolParamsTable(params) {
  const rows = params.map((param) => {
    const notes = [];
    if (param.default) notes.push(t("tools-param-default").replace("{value}", param.default));
    if (param.note) notes.push(param.note);
    return `<tr><td><code>${escape(param.name)}</code></td><td>${param.type ? `<code>${escape(param.type)}</code>` : "—"}</td><td class="${param.required ? "tool-param-required" : "tool-param-optional"}">${escape(param.required ? t("tools-param-required") : t("tools-param-optional"))}</td><td>${notes.length > 0 ? escape(notes.join("；")) : "—"}</td></tr>`;
  }).join("");
  return `<table class="tool-params"><thead><tr><th>${escape(t("tools-param-name"))}</th><th>${escape(t("tools-param-type"))}</th><th>${escape(t("tools-param-requirement"))}</th><th>${escape(t("tools-param-detail"))}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function toolCategoryEmpty(text) {
  return `<div class="tool-empty"><p>${escape(text)}</p></div>`;
}

/** Every server is one jump row; the list never prints a tool body. 每个服务器都是一行跳转；列表从不打印工具正文。 */
function serverRow(server) {
  const tools = Array.isArray(server.tools) ? server.tools : [];
  const status = server.enabled ? t("tools-loaded") : t("tools-not-loaded");
  return `<button class="tool-list-row" type="button" data-tool-detail="${escape(server.id)}"><span class="tool-list-main"><b>${escape(server.id)}</b><small>${escape(server.transport)} · ${tools.length} ${escape(t("tools-tools"))} · ${escape(status)}</small></span><span class="tool-list-chevron" aria-hidden="true">›</span></button>`;
}

/** Every skill is one jump row. 每个技能都是一行跳转。 */
function skillRow(skill) {
  return `<button class="tool-list-row" type="button" data-skill-detail="${escape(skill.name)}"><span class="tool-list-main"><b>${escape(skill.name)}</b><small>${escape(skill.description)}</small></span><span class="tool-list-chevron" aria-hidden="true">›</span></button>`;
}

function renderToolsCatalog(catalog) {
  state.toolsCatalog = catalog;
  const host = $("tools-catalog");
  if (!host) return;
  const servers = Array.isArray(catalog?.servers) ? catalog.servers : [];
  const skills = Array.isArray(catalog?.skills) ? catalog.skills : [];
  const enabledCount = servers.filter((server) => server.enabled).length;
  const summary = $("tools-summary");
  if (summary) summary.textContent = `${t("tools-loaded")} ${enabledCount}/${servers.length} · ${skills.length} ${t("tools-skills")}`;
  const errors = Array.isArray(catalog?.mcpErrors) && catalog.mcpErrors.length
    ? `<div class="tool-warning tool-category-warning"><h4>${escape(t("tools-mcp-errors"))}</h4>${catalog.mcpErrors.map((error) => `<p><code>${escape(error)}</code></p>`).join("")}</div>`
    : "";
  const rejected = Array.isArray(catalog?.rejectedSkills) && catalog.rejectedSkills.length
    ? `<details class="tool-rejected"><summary>${escape(t("tools-rejected"))} (${catalog.rejectedSkills.length})</summary><ul>${catalog.rejectedSkills.map((entry) => `<li><code>${escape(entry.path)}</code> ${escape(entry.reason)}</li>`).join("")}</ul></details>`
    : "";
  const roots = (Array.isArray(catalog?.skillRoots) ? catalog.skillRoots : []).map((root) => `<code>${escape(root)}</code>`).join(" ");
  host.innerHTML = `<section class="tool-category" data-tool-category="mcp">
      <div class="tool-category-head"><div><h4>${escape(t("tools-category-mcp"))}</h4><p>${enabledCount}/${servers.length} ${escape(t("tools-loaded"))}</p></div><button class="provider-install" type="button" data-tools-market="mcp">${escape(t("tools-category-mcp-install"))}</button></div>
      ${errors}
      <div class="tool-row-list">${servers.length ? servers.map(serverRow).join("") : toolCategoryEmpty(t("tools-empty"))}</div>
    </section>
    <section class="tool-category" data-tool-category="skills">
      <div class="tool-category-head"><div><h4>${escape(t("tools-category-skills"))}</h4><p>${skills.length} ${escape(t("tools-skills"))}</p></div><button class="provider-install" type="button" data-tools-market="skills">${escape(t("tools-category-skills-get"))}</button></div>
      <div class="tool-row-list">${skills.length ? skills.map(skillRow).join("") : toolCategoryEmpty(t("tools-no-skills"))}</div>
      ${rejected}
      <p class="agent-runtime-note tool-category-note">${escape(t("tools-skill-roots"))}: ${roots}</p>
    </section>
    <p class="agent-runtime-note">${escape(t("tools-next-run"))}</p>`;
  const top = currentToolsView();
  if (top?.kind === "server") renderToolsDetail();
  else if (top?.kind === "mcp-market") renderMarketResults();
  else if (top?.kind === "skill-market") renderSkillMarketResults();
}

function currentToolsView() {
  return state.toolsStack[state.toolsStack.length - 1];
}

/** The localized half of a registry text pair. 注册表文本对中当前语言的一条。 */
function registryText(value) {
  if (typeof value !== "object" || value === null) return String(value ?? "");
  return value[state.locale] || value.en || value["zh-CN"] || "";
}

function renderMarketResults() {
  const host = $("tools-market-results");
  if (!host) return;
  // Before the first response, "no results" would be a false empty state.
  // 首次响应之前，"没有结果"是一个假的空状态。
  if (!state.toolsMarketLoaded && state.toolsMarketError === null) {
    host.innerHTML = `<p class="memory-empty">${escape(t("tools-market-loading"))}</p>`;
    return;
  }
  if (state.toolsMarketLoading && state.toolsMarketResults.length === 0) {
    host.innerHTML = `<p class="memory-empty">${escape(t("tools-market-loading"))}</p>`;
    return;
  }
  if (state.toolsMarketError) {
    host.innerHTML = `<p class="memory-empty">${escape(state.toolsMarketError)}</p>`;
    return;
  }
  const entries = state.toolsMarketResults;
  const installed = new Set((state.toolsCatalog?.servers ?? []).map((server) => server.id));
  const count = $("tools-market-count");
  if (count) {
    count.textContent = state.toolsMarketQuery.trim().length > 0
      ? t("tools-market-filtered").replace("{count}", String(entries.length)).replace("{total}", String(state.toolsMarketTotal))
      // "Installable" counts what is not installed yet; an installed entry keeps
      // its card with a badge instead of an install button.
      // "可安装"只数尚未安装的条目；已安装条目保留卡片并显示徽章，而不是安装按钮。
      : t("tools-market-count").replace("{count}", String(entries.filter((entry) => !installed.has(entry.id)).length));
  }
  if (entries.length === 0) {
    host.innerHTML = `<p class="memory-empty">${escape(t("tools-market-empty"))}</p>`;
    return;
  }
  host.innerHTML = entries.map((entry) => {
    const has = installed.has(entry.id);
    return `<article class="market-card" data-market-card="${escape(entry.id)}">
      <div class="market-card-title"><h5>${escape(registryText(entry.name))}</h5><span class="market-flag">${escape(t(`tools-vendor-${entry.vendor}`))}</span></div>
      <p>${escape(registryText(entry.summary))}</p>
      <code>${escape(entry.package)}</code>
      ${has
        ? `<span class="market-installed">${escape(t("tools-market-installed"))}</span>`
        : `<button class="provider-install market-open" type="button" data-market-open="${escape(entry.id)}">${escape(t("tools-market-open"))}</button>`}
    </article>`;
  }).join("");
}

async function refreshToolsMarket(query = state.toolsMarketQuery) {
  const input = $("tools-market-search");
  const next = typeof query === "string" ? query : "";
  state.toolsMarketQuery = next;
  if (input && input.value !== next) input.value = next;
  state.toolsMarketLoading = true;
  state.toolsMarketError = null;
  renderMarketResults();
  try {
    const result = await api(`/api/tools/registry?q=${encodeURIComponent(next)}`);
    state.toolsRegistry = Array.isArray(result.entries) ? result.entries : [];
    state.toolsMarketResults = state.toolsRegistry;
    state.toolsMarketTotal = typeof result.total === "number" ? result.total : state.toolsRegistry.length;
  } catch (error) {
    state.toolsMarketError = error.message || t("tools-market-error");
    state.toolsRegistry = [];
    state.toolsMarketResults = [];
  } finally {
    state.toolsMarketLoading = false;
    state.toolsMarketLoaded = true;
    renderMarketResults();
  }
}

function renderSkillMarketResults() {
  const host = $("skills-market-results");
  if (!host) return;
  if (!state.skillsMarketLoaded && state.skillsMarketError === null) {
    host.innerHTML = `<p class="memory-empty">${escape(t("skills-market-loading"))}</p>`;
    return;
  }
  if (state.skillsMarketLoading && state.skillsMarketResults.length === 0) {
    host.innerHTML = `<p class="memory-empty">${escape(t("skills-market-loading"))}</p>`;
    return;
  }
  if (state.skillsMarketError) {
    host.innerHTML = `<p class="memory-empty">${escape(state.skillsMarketError)}</p>`;
    return;
  }
  const entries = state.skillsMarketResults;
  const installed = new Set((state.toolsCatalog?.skills ?? []).map((skill) => skill.name));
  const count = $("skills-market-count");
  if (count) {
    count.textContent = state.skillsMarketQuery.trim().length > 0
      ? t("skills-market-filtered").replace("{count}", String(entries.length)).replace("{total}", String(state.skillsMarketTotal))
      : t("skills-market-count").replace("{count}", String(entries.filter((entry) => !installed.has(entry.name)).length));
  }
  if (entries.length === 0) {
    host.innerHTML = `<p class="memory-empty">${escape(t("skills-market-empty"))}</p>`;
    return;
  }
  host.innerHTML = entries.map((entry) => {
    const has = installed.has(entry.name);
    return `<article class="market-card" data-skill-card="${escape(entry.name)}">
      <div class="market-card-title"><h5>${escape(entry.name)}</h5><span class="market-flag">${escape(registryText(entry.category))}</span>${has ? `<span class="market-installed">${escape(t("tools-market-installed"))}</span>` : ""}</div>
      <p>${escape(registryText(entry.summary))}</p>
      <button class="provider-install market-open" type="button" data-skill-entry="${escape(entry.name)}">${escape(t("tools-market-view"))}</button>
    </article>`;
  }).join("");
}

async function refreshSkillMarket(query = state.skillsMarketQuery) {
  const input = $("skills-market-search");
  const next = typeof query === "string" ? query : "";
  state.skillsMarketQuery = next;
  if (input && input.value !== next) input.value = next;
  state.skillsMarketLoading = true;
  state.skillsMarketError = null;
  renderSkillMarketResults();
  try {
    const result = await api(`/api/skills/registry?q=${encodeURIComponent(next)}`);
    state.skillsRegistry = Array.isArray(result.entries) ? result.entries : [];
    state.skillsMarketResults = state.skillsRegistry;
    state.skillsMarketTotal = typeof result.total === "number" ? result.total : state.skillsRegistry.length;
  } catch (error) {
    state.skillsMarketError = error.message || t("skills-market-error");
    state.skillsRegistry = [];
    state.skillsMarketResults = [];
  } finally {
    state.skillsMarketLoading = false;
    state.skillsMarketLoaded = true;
    renderSkillMarketResults();
  }
}

function serverDetailMarkup(server) {
  const tools = Array.isArray(server.tools) ? server.tools : [];
  const status = server.enabled ? t("tools-loaded") : t("tools-not-loaded");
  const action = server.enabled ? t("tools-unload") : t("tools-load");
  const cards = tools.length > 0
    ? tools.map((tool) => {
        const meta = toolMeta(tool.description);
        return `<article class="tool-detail-card">
          <header><code>${escape(tool.name)}</code>${toolRiskBadge(tool.risk)}</header>
          ${meta.summary ? `<p class="tool-summary">${escape(meta.summary)}</p>` : ""}
          ${meta.params.length > 0 ? toolParamsTable(meta.params) : ""}
        </article>`;
      }).join("")
    : `<p class="memory-empty">${escape(t("tools-server-empty"))}</p>`;
  return `<button class="tool-back" type="button" data-tools-back>${escape(t("tools-back-short"))}</button>
    <div class="tool-detail-heading">
      <div><h4>${escape(server.id)}</h4><p>${escape(server.transport)} · ${tools.length} ${escape(t("tools-tools"))} · ${escape(status)}</p></div>
      <div class="tool-server-actions"><button class="provider-install" type="button" data-tool-toggle="${escape(server.id)}" data-tool-enabled="${server.enabled ? "false" : "true"}">${escape(action)}</button><button class="provider-install tool-server-remove" type="button" data-tool-remove="${escape(server.id)}">${escape(t("tools-install-remove"))}</button></div>
    </div>
    <div class="tool-detail-list">${cards}</div>`;
}

function mcpMarketMarkup() {
  return `<button class="tool-back" type="button" data-tools-back>${escape(t("tools-back-short"))}</button>
    <div class="tool-detail-heading">
      <div><h4>${escape(t("tools-market-title"))}</h4><p>${escape(t("tools-market-lead"))}</p></div>
      <span class="settings-value" id="tools-market-count"></span>
    </div>
    <input class="tools-market-search" id="tools-market-search" type="search" autocomplete="off" spellcheck="false" placeholder="${escape(t("tools-market-search"))}" aria-label="${escape(t("tools-market-search-label"))}" value="${escape(state.toolsMarketQuery)}"/>
    <div class="tools-market-results" id="tools-market-results"></div>
    <details class="tool-manual" id="tool-install-card">
      <summary>${escape(t("tools-manual-title"))}</summary>
      <p>${escape(t("tools-install-lead"))}</p>
      <div class="tool-install-fields">
        <label><span>${escape(t("tools-install-id"))}</span><input id="tool-install-id" placeholder="filesystem" autocomplete="off" spellcheck="false"/></label>
        <label><span>${escape(t("tools-install-package"))}</span><input id="tool-install-package" placeholder="@modelcontextprotocol/server-filesystem@2.4.0" autocomplete="off" spellcheck="false"/></label>
        <label><span>${escape(t("tools-install-args"))}</span><input id="tool-install-args" placeholder="--read-only /Users/you/Documents" autocomplete="off" spellcheck="false"/></label>
      </div>
      <div class="memory-tool-row tool-install-actions">
        <button class="secondary" type="button" id="tool-install-probe">${escape(t("tools-install-probe"))}</button>
        <button class="primary" type="button" id="tool-install-confirm" disabled>${escape(t("tools-install-confirm"))}</button>
      </div>
      <div class="tool-install-tools" id="tool-install-tools"></div>
    </details>`;
}

function marketDetailMarkup(entry) {
  const inputs = (Array.isArray(entry.inputs) ? entry.inputs : []).map((input) => {
    const hint = input.hint ? `<small>${escape(registryText(input.hint))}</small>` : "";
    if ((input.kind ?? "text") === "toggle") {
      return `<label class="tool-toggle"><input type="checkbox" data-market-input="${escape(input.key)}" ${input.defaultChecked ? "checked" : ""}/><span>${escape(registryText(input.label))}</span></label>`;
    }
    return `<label><span>${escape(registryText(input.label))}${input.required ? ` <em>${escape(t("tools-param-required"))}</em>` : ""}</span><input type="text" data-market-input="${escape(input.key)}" placeholder="${escape(input.placeholder || "")}" autocomplete="off" spellcheck="false"/>${hint}</label>`;
  }).join("");
  return `<button class="tool-back" type="button" data-tools-back>${escape(t("tools-back-short"))}</button>
    <div class="tool-detail-heading">
      <div><h4>${escape(registryText(entry.name))}</h4><p>${escape(t(`tools-vendor-${entry.vendor}`))} · <code>${escape(entry.package)}</code></p></div>
    </div>
    <p class="tool-market-summary">${escape(registryText(entry.summary))}</p>
    ${entry.docs ? `<p class="tool-docs"><a href="${escape(entry.docs)}" target="_blank" rel="noreferrer">${escape(t("tools-market-docs"))}</a></p>` : ""}
    <div class="tool-install-fields">${inputs}</div>
    <div class="memory-tool-row tool-install-actions">
      <button class="secondary" type="button" id="tool-market-probe">${escape(t("tools-install-probe"))}</button>
      <button class="primary" type="button" id="tool-market-install" disabled>${escape(t("tools-install-confirm"))}</button>
    </div>
    <div class="tool-install-tools" id="tool-market-probe-tools"></div>`;
}

function skillMarketMarkup() {
  return `<button class="tool-back" type="button" data-tools-back>${escape(t("tools-back-short"))}</button>
    <div class="tool-detail-heading">
      <div><h4>${escape(t("skills-market-title"))}</h4><p>${escape(t("skills-market-lead"))}</p></div>
      <span class="settings-value" id="skills-market-count"></span>
    </div>
    <input class="tools-market-search" id="skills-market-search" type="search" autocomplete="off" spellcheck="false" placeholder="${escape(t("skills-market-search"))}" aria-label="${escape(t("skills-market-search-label"))}" value="${escape(state.skillsMarketQuery)}"/>
    <div class="tools-market-results" id="skills-market-results"></div>`;
}

function isSkillInstalled(name) {
  return (state.toolsCatalog?.skills ?? []).some((skill) => skill.name === name);
}

function isManagedSkillPath(path) {
  const root = (state.toolsCatalog?.skillRoots ?? [])[0];
  return typeof root === "string" && typeof path === "string" && path.startsWith(`${root}/`);
}

function skillEntryMarkup(entry) {
  const installed = isSkillInstalled(entry.name);
  const tools = Array.isArray(entry.allowedTools) && entry.allowedTools.length > 0
    ? `<p class="tool-skill-meta">${escape(t("tools-skill-allowed"))}: ${entry.allowedTools.map((tool) => `<code>${escape(tool)}</code>`).join(" ")}</p>`
    : "";
  return `<button class="tool-back" type="button" data-tools-back>${escape(t("tools-back-short"))}</button>
    <div class="tool-detail-heading">
      <div><h4>${escape(entry.name)}</h4><p>${escape(registryText(entry.category))} · ${escape(t("tools-skill-source-builtin"))}</p></div>
    </div>
    <p class="tool-market-summary">${escape(registryText(entry.summary))}</p>
    ${tools}
    <div class="tool-skill-body">${richText(entry.body)}</div>
    <div class="memory-tool-row tool-install-actions">
      ${installed
        ? `<button class="provider-install" type="button" data-skill-detail="${escape(entry.name)}">${escape(t("tools-market-view-installed"))}</button>`
        : `<button class="primary" type="button" id="skill-market-install" data-skill-install="${escape(entry.name)}">${escape(t("tools-skill-install"))}</button>`}
    </div>`;
}

function skillDetailMarkup(view) {
  const detail = state.skillDetails.get(view.name);
  const back = `<button class="tool-back" type="button" data-tools-back>${escape(t("tools-back-short"))}</button>`;
  if (detail === undefined || detail.status === "loading") {
    return `${back}<p class="memory-empty">${escape(t("tools-skill-detail-loading"))}</p>`;
  }
  if (detail.status === "error") {
    return `${back}<p class="memory-empty">${escape(detail.error)}</p>`;
  }
  const skill = detail.skill;
  const allowed = Array.isArray(skill.allowedTools) && skill.allowedTools.length > 0
    ? `<p class="tool-skill-meta">${escape(t("tools-skill-allowed"))}: ${skill.allowedTools.map((tool) => `<code>${escape(tool)}</code>`).join(" ")}</p>`
    : "";
  return `${back}
    <div class="tool-detail-heading">
      <div><h4>${escape(skill.name)}</h4><p>${escape(skill.path)}</p></div>
      ${isManagedSkillPath(skill.path) ? `<div class="tool-server-actions"><button class="provider-install tool-server-remove" type="button" data-skill-remove="${escape(skill.name)}">${escape(t("tools-skill-remove"))}</button></div>` : ""}
    </div>
    <p class="tool-market-summary">${escape(skill.description)}</p>
    ${allowed}
    <div class="tool-skill-body">${richText(skill.body)}</div>`;
}

function loadSkillDetail(name) {
  const cached = state.skillDetails.get(name);
  if (cached !== undefined) return;
  state.skillDetails.set(name, { status: "loading" });
  void api(`/api/skills/${encodeURIComponent(name)}`)
    .then((result) => { state.skillDetails.set(name, { status: "ready", skill: result.skill }); })
    .catch((error) => { state.skillDetails.set(name, { status: "error", error: error.message }); })
    .finally(() => {
      const top = currentToolsView();
      if (top?.kind === "skill" && top.name === name) renderToolsDetail();
    });
}

function renderToolsDetail(options = {}) {
  const list = $("tools-list-view");
  const host = $("tools-detail");
  if (!list || !host) return;
  const view = currentToolsView();
  if (view === undefined) {
    list.hidden = false;
    host.hidden = true;
    host.innerHTML = "";
    if (options.focus) document.querySelector('#tools-catalog [data-tools-market="mcp"]')?.focus();
    return;
  }
  let markup;
  if (view.kind === "server") {
    const server = (state.toolsCatalog?.servers ?? []).find((candidate) => candidate.id === view.id);
    if (server === undefined) {
      state.toolsStack = [];
      renderToolsDetail(options);
      return;
    }
    markup = serverDetailMarkup(server);
  } else if (view.kind === "mcp-market") {
    markup = mcpMarketMarkup();
  } else if (view.kind === "mcp-entry") {
    const entry = (state.toolsRegistry ?? []).find((candidate) => candidate.id === view.id);
    if (entry === undefined) {
      state.toolsStack.pop();
      renderToolsDetail(options);
      return;
    }
    markup = marketDetailMarkup(entry);
  } else if (view.kind === "skill-market") {
    markup = skillMarketMarkup();
  } else if (view.kind === "skill-entry") {
    const entry = (state.skillsRegistry ?? []).find((candidate) => candidate.name === view.name);
    if (entry === undefined) {
      state.toolsStack.pop();
      renderToolsDetail(options);
      return;
    }
    markup = skillEntryMarkup(entry);
  } else {
    markup = skillDetailMarkup(view);
  }
  list.hidden = true;
  host.hidden = false;
  host.innerHTML = markup;
  if (view.kind === "mcp-market") renderMarketResults();
  if (view.kind === "skill-market") renderSkillMarketResults();
  if (view.kind === "skill") loadSkillDetail(view.name);
  if (options.resetScroll) {
    const content = document.querySelector(".settings-content");
    if (content) content.scrollTop = 0;
  }
  if (options.focus) host.querySelector("[data-tools-back]")?.focus();
}

function openToolsView(view) {
  // Keep the list's reading position for the back control; a jump starts at the
  // top of its own page.
  // 为返回控件记住列表的阅读位置；跳转从自己的页面顶部开始。
  const content = document.querySelector(".settings-content");
  if (state.toolsStack.length === 0) state.toolsListScroll = content ? content.scrollTop : 0;
  state.toolsStack.push(view);
  state.toolsProbe = [];
  renderToolsDetail({ resetScroll: true, focus: true });
}

function backToolsView() {
  if (state.toolsStack.length === 0) return;
  state.toolsStack.pop();
  state.toolsProbe = [];
  renderToolsDetail({ resetScroll: true, focus: true });
  if (state.toolsStack.length === 0) {
    const content = document.querySelector(".settings-content");
    if (content) content.scrollTop = state.toolsListScroll ?? 0;
  }
}

function closeToolsView() {
  state.toolsStack = [];
  state.toolsProbe = [];
  renderToolsDetail({ resetScroll: true, focus: true });
  const content = document.querySelector(".settings-content");
  if (content) content.scrollTop = state.toolsListScroll ?? 0;
}

function openToolsMarket(kind) {
  if (kind === "mcp") {
    openToolsView({ kind: "mcp-market" });
    if (!state.toolsMarketLoaded) void refreshToolsMarket();
    else renderMarketResults();
  } else {
    openToolsView({ kind: "skill-market" });
    if (!state.skillsMarketLoaded) void refreshSkillMarket();
    else renderSkillMarketResults();
  }
}

function readMarketInputs(entry) {
  const inputs = {};
  for (const input of Array.isArray(entry.inputs) ? entry.inputs : []) {
    const node = document.querySelector(`[data-market-input="${CSS.escape(input.key)}"]`);
    if (node === null) continue;
    inputs[input.key] = (input.kind ?? "text") === "toggle" ? node.checked : node.value;
  }
  return inputs;
}

function marketplaceEntry() {
  const view = currentToolsView();
  if (view?.kind !== "mcp-entry") return undefined;
  return (state.toolsRegistry ?? []).find((candidate) => candidate.id === view.id);
}

async function refreshToolsCatalog() {
  if (state.toolsLoading) return;
  state.toolsLoading = true;
  const host = $("tools-catalog");
  if (host && state.toolsCatalog === null) host.innerHTML = `<p class="memory-empty">${escape(t("tools-loading"))}</p>`;
  try {
    renderToolsCatalog(await api("/api/tools"));
  } catch (error) {
    if (host) host.innerHTML = `<p class="memory-empty">${escape(error.message)}</p>`;
  } finally {
    state.toolsLoading = false;
  }
}
async function toggleMcpServer(id, enabled) {
  const button = document.querySelector(`[data-tool-toggle="${CSS.escape(id)}"]`);
  if (button) button.disabled = true;
  try {
    const catalog = await api(`/api/tools/mcp/${encodeURIComponent(id)}/enabled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    renderToolsCatalog(catalog);
    announce(`${enabled ? t("tools-loaded-msg") : t("tools-unloaded-msg")} ${id}`);
  } catch (error) {
    if (button) button.disabled = false;
    announce(error.message, true);
  }
}
// A JSON array keeps arguments with spaces intact; anything else splits on
// whitespace, because a shell-style string is what an owner will type.
// JSON 数组保留带空格的参数；其余按空白切分，因为所有者会按 Shell 风格输入。
function parseArgsInput(value) {
  const text = String(value ?? "").trim();
  if (text.length === 0) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
    } catch {
      // A bracket that is not JSON is still a plausible argument; fall through.
      // 不是 JSON 的方括号仍是可能的参数；继续按空白切分。
    }
  }
  return text.split(/\s+/).filter((item) => item.length > 0);
}
function renderProbeTools(hostId = "tool-install-tools") {
  const host = $(hostId);
  const confirm = $(hostId === "tool-install-tools" ? "tool-install-confirm" : "tool-market-install");
  if (!host) return;
  const tools = state.toolsProbe;
  if (tools.length === 0) {
    host.innerHTML = `<p class="memory-empty">${escape(t("tools-install-no-tools"))}</p>`;
    if (confirm) confirm.disabled = true;
    return;
  }
  const presets = ["read", "write", "network"]
    .map((risk) => `<button class="secondary" type="button" data-install-preset="${risk}">${escape(t(`tools-${risk}`))}</button>`)
    .join("");
  const options = ["external", "read", "write", "network"]
    .map((risk) => `<option value="${risk}">${escape(t(`tools-${risk}`))}</option>`)
    .join("");
  const rows = tools.map((tool) => {
    const meta = toolMeta(tool.description, tool.inputSchema);
    const params = meta.params.length > 0
      ? `<details class="tool-probe-params"><summary>${escape(t("tools-params-title"))} (${meta.params.length})</summary>${toolParamsTable(meta.params)}</details>`
      : "";
    return `<div class="tool-install-item"><div class="tool-install-row"><code>${escape(tool.name)}</code><select data-install-risk="${escape(tool.name)}" aria-label="${escape(tool.name)}">${options}</select><span class="tool-description">${escape(meta.summary)}</span></div>${params}</div>`;
  }).join("");
  host.innerHTML = `<div class="memory-tool-row tool-install-presets"><span>${escape(t("tools-install-risk"))}</span>${presets}</div>${rows}`;
  // Every tool starts at `external` (refused); the owner must choose a risk.
  // 每个工具从 `external`（拒绝）开始；风险必须由所有者选择。
  for (const select of host.querySelectorAll("[data-install-risk]")) select.value = "external";
  if (confirm) confirm.disabled = false;
}
async function probeInstall() {
  const spec = $("tool-install-package")?.value.trim() ?? "";
  if (spec.length === 0) {
    announce(t("tools-install-missing"), true);
    return;
  }
  const button = $("tool-install-probe");
  const host = $("tool-install-tools");
  if (button) button.disabled = true;
  if (host) host.innerHTML = `<p class="memory-empty">${escape(t("tools-install-probing"))}</p>`;
  try {
    const result = await api("/api/tools/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ package: spec, args: parseArgsInput($("tool-install-args")?.value) }),
    });
    state.toolsProbe = Array.isArray(result.tools) ? result.tools : [];
    renderProbeTools("tool-install-tools");
  } catch (error) {
    state.toolsProbe = [];
    if (host) host.innerHTML = `<p class="memory-empty">${escape(error.message)}</p>`;
    const confirm = $("tool-install-confirm");
    if (confirm) confirm.disabled = true;
  } finally {
    if (button) button.disabled = false;
  }
}
async function probeMarketEntry() {
  const entry = marketplaceEntry();
  if (entry === undefined) return;
  const button = $("tool-market-probe");
  const host = $("tool-market-probe-tools");
  if (button) button.disabled = true;
  if (host) host.innerHTML = `<p class="memory-empty">${escape(t("tools-install-probing"))}</p>`;
  try {
    const result = await api("/api/tools/probe-registry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: entry.id, inputs: readMarketInputs(entry) }),
    });
    state.toolsProbe = Array.isArray(result.tools) ? result.tools : [];
    renderProbeTools("tool-market-probe-tools");
  } catch (error) {
    state.toolsProbe = [];
    if (host) host.innerHTML = `<p class="memory-empty">${escape(error.message)}</p>`;
    const confirm = $("tool-market-install");
    if (confirm) confirm.disabled = true;
  } finally {
    if (button) button.disabled = false;
  }
}
function resetInstallForm() {
  state.toolsProbe = [];
  for (const id of ["tool-install-id", "tool-install-package", "tool-install-args"]) {
    const input = $(id);
    if (input) input.value = "";
  }
  const host = $("tool-install-tools");
  if (host) host.innerHTML = "";
  const confirm = $("tool-install-confirm");
  if (confirm) confirm.disabled = true;
}
async function installMcpServerFromUi() {
  const id = $("tool-install-id")?.value.trim() ?? "";
  const spec = $("tool-install-package")?.value.trim() ?? "";
  if (id.length === 0 || spec.length === 0) {
    announce(t("tools-install-missing"), true);
    return;
  }
  const selects = [...document.querySelectorAll("#tool-install-tools [data-install-risk]")];
  if (selects.length === 0) {
    announce(t("tools-install-probe-first"), true);
    return;
  }
  const tools = selects.map((select) => ({ name: select.dataset.installRisk, risk: select.value }));
  const external = tools.filter((tool) => tool.risk === "external").length;
  const message = t("tools-install-confirm-body")
    .replace("{package}", spec)
    .replace("{count}", String(tools.length))
    .replace("{external}", String(external));
  if (!(await confirmDialog(message, t("tools-install-confirm")))) return;
  const button = $("tool-install-confirm");
  if (button) button.disabled = true;
  try {
    const catalog = await api("/api/tools/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id,
        package: spec,
        args: parseArgsInput($("tool-install-args")?.value),
        tools,
        acknowledgeInstall: true,
      }),
    });
    renderToolsCatalog(catalog);
    resetInstallForm();
    void refreshToolsMarket(state.toolsMarketQuery);
    announce(`${t("tools-install-success")} ${id}`);
  } catch (error) {
    announce(error.message, true);
    if (button) button.disabled = false;
  }
}
async function installFromMarket() {
  const entry = marketplaceEntry();
  if (entry === undefined) return;
  const selects = [...document.querySelectorAll("#tool-market-probe-tools [data-install-risk]")];
  if (selects.length === 0) {
    announce(t("tools-install-probe-first"), true);
    return;
  }
  const tools = selects.map((select) => ({ name: select.dataset.installRisk, risk: select.value }));
  const external = tools.filter((tool) => tool.risk === "external").length;
  const message = t("tools-install-confirm-body")
    .replace("{package}", entry.package)
    .replace("{count}", String(tools.length))
    .replace("{external}", String(external));
  if (!(await confirmDialog(message, t("tools-install-confirm")))) return;
  const button = $("tool-market-install");
  if (button) button.disabled = true;
  try {
    const catalog = await api("/api/tools/install-registry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entryId: entry.id,
        inputs: readMarketInputs(entry),
        tools,
        acknowledgeInstall: true,
      }),
    });
    renderToolsCatalog(catalog);
    // Return to the market so another server can be installed; the card now
    // carries the installed badge.
    // 回到市场以便继续安装其他服务器；卡片此时带已安装徽章。
    state.toolsStack.pop();
    renderToolsDetail({ resetScroll: true, focus: true });
    void refreshToolsMarket(state.toolsMarketQuery);
    announce(`${t("tools-install-success")} ${entry.id}`);
  } catch (error) {
    announce(error.message, true);
    if (button) button.disabled = false;
  }
}
async function installSkillFromUi(name) {
  const root = (state.toolsCatalog?.skillRoots ?? [])[0] ?? "";
  const path = `${root}/${name}/SKILL.md`;
  const message = t("tools-skill-install-body").replace("{name}", name).replace("{path}", path);
  if (!(await confirmDialog(message, t("tools-skill-install")))) return;
  const button = document.querySelector(`[data-skill-install="${CSS.escape(name)}"]`);
  if (button) button.disabled = true;
  try {
    const catalog = await api("/api/skills/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, acknowledgeInstall: true }),
    });
    state.skillDetails.delete(name);
    renderToolsCatalog(catalog);
    void refreshSkillMarket(state.skillsMarketQuery);
    renderToolsDetail();
    announce(`${t("tools-skill-install-success")} ${name}`);
  } catch (error) {
    announce(error.message, true);
    if (button) button.disabled = false;
  }
}
async function removeSkillFromUi(name) {
  const detail = state.skillDetails.get(name);
  const path = detail?.skill?.path ?? name;
  const message = t("tools-skill-remove-body").replace("{name}", name).replace("{path}", path);
  if (!(await confirmDialog(message, t("tools-skill-remove")))) return;
  try {
    const catalog = await api(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
    state.skillDetails.delete(name);
    renderToolsCatalog(catalog);
    void refreshSkillMarket(state.skillsMarketQuery);
    closeToolsView();
    announce(`${t("tools-skill-remove-success")} ${name}`);
  } catch (error) {
    announce(error.message, true);
  }
}
async function removeMcpServerFromUi(id) {
  const message = t("tools-install-remove-body").replace("{id}", id);
  if (!(await confirmDialog(message, t("tools-install-remove")))) return;
  const fromDetail = currentToolsView()?.kind === "server" && currentToolsView().id === id;
  try {
    const catalog = await api(`/api/tools/mcp/${encodeURIComponent(id)}`, { method: "DELETE" });
    renderToolsCatalog(catalog);
    // The catalog refresh already returns to the list when its server vanished;
    // closeToolsView restores the list's reading position in either case.
    // 目录刷新在服务器消失时已回到列表；closeToolsView 在两种情况下都恢复列表的阅读位置。
    if (fromDetail) closeToolsView();
    announce(`${t("tools-install-removed")} ${id}`);
  } catch (error) {
    announce(error.message, true);
  }
}

function renderAgentPage() {
  const host = $("agent-page");
  if (!host || !state.settings) return;
  const settings = state.settings;
  const gateway = state.gateways.find((candidate) => candidate.id === "magpie");
  const mainAgentModel = state.config?.config?.mainAgentModel || "";
  const signature = JSON.stringify([settings.agents, gateway, mainAgentModel, state.gatewayLoading]);
  if (state.signatures.agentPage === signature) return;
  state.signatures.agentPage = signature;
  const gatewayState = gateway?.running
    ? { label: t("gateway-running"), tone: "success" }
    : gateway?.installed
      ? { label: t("gateway-stopped"), tone: "warning" }
      : { label: t("gateway-not-found"), tone: "neutral" };
  const gatewayBadge = ui.badge(
    state.gatewayLoading && gateway === undefined ? t("gateway-checking") : gatewayState.label,
    state.gatewayLoading && gateway === undefined ? "neutral" : gatewayState.tone,
    { dot: true },
  );
  const exposedModels = (gateway?.models || []).filter((model) => model.compatible !== false);
  const selectedModel = selectedGatewayModel(mainAgentModel, exposedModels);
  const modelSelect = exposedModels.length
    ? ui.select({
        value: selectedModel,
        attributes: { id: "gateway-model", "aria-label": t("gateway-model") },
        options: exposedModels.map((model) => ({
          value: model.id,
          label: `${model.name}${model.provider && model.provider !== "" ? ` · ${model.provider}` : ""}`,
        })),
      })
    : "";
  const gatewayControls = gateway?.running && exposedModels.length
    ? `<div class="gateway-controls">
        <div class="gateway-controls__row">${modelSelect}${ui.button({ label: t("gateway-use"), iconName: "arrow", variant: "primary", disabled: !selectedModel, attributes: { "data-gateway-apply": "" } })}</div>
        <div class="c-cluster">${ui.button({ label: t("gateway-refresh"), iconName: "refresh", variant: "secondary", attributes: { "data-gateway-refresh": "" } })}${mainAgentModel ? ui.button({ label: t("gateway-clear"), variant: "ghost", attributes: { "data-gateway-clear": "" } }) : ""}</div>
      </div>`
    : `<div class="gateway-controls"><div class="c-cluster">${ui.button({ label: t("gateway-refresh"), iconName: "refresh", variant: "secondary", attributes: { "data-gateway-refresh": "" } })}</div><span class="gateway-hint">${escape(gateway?.running && gateway.modelCount > 0 ? t("gateway-pi-hint") : gateway?.error || t("gateway-start-hint"))}</span></div>`;
  const gatewayCard = ui.card({
    title: "Magpie Gateway",
    subtitle: "Clone AI 的模型端点，由本机 Magpie Gateway 提供。",
    tone: gateway?.running ? "accent" : "warning",
    className: "agent-gateway",
    actions: gatewayBadge,
    body: `<div class="gateway-layout"><div class="gateway-summary">${ui.providerMark("Magpie", "magpie")}<div class="gateway-summary__copy"><strong>${escape(gateway?.running ? t("gateway-connected") : gateway?.installed ? t("gateway-installed") : t("gateway-unavailable"))}</strong><p class="agent-role-note">${escape(t("gateway-recognition-note"))}</p></div></div>${gatewayControls}</div>`,
  });
  const agentRows = settings.agents.map((agent) => {
    const description = agent.role === "external" ? t("external-unavailable") : agent.description;
    const purpose = agent.role === "external" ? t("external-unavailable-detail") : agent.purpose;
    return ui.listRow({
      leading: ui.providerMark("Built-in", "native"),
      title: agent.title,
      description,
      meta: `${ui.badge(agentRoleLabel(agent.role), "neutral")}<span>${escape(purpose)}</span>`,
    });
  }).join("");
  const allEnabled = settings.agents.length > 0 && settings.agents.every((agent) => agent.enabled);
  host.innerHTML = `<div class="agent-page">
    ${ui.sectionHeader({
      eyebrow: t("agent-page-eyebrow"),
      title: t("agents-title"),
      description: "Main Agent 由 Clone AI 自己持有；模型由本机 Magpie Gateway 提供。",
      actions: ui.button({ label: t("gateway-refresh"), iconName: "refresh", variant: "secondary", attributes: { "data-settings-refresh": "" } }),
    })}
    <div class="c-stat-grid agent-overview">${ui.stat({ label: "Main Agent", value: "内置", detail: "Clone AI 原生工具循环", tone: "success" })}${ui.stat({ label: t("stat-gateway"), value: gateway?.running ? t("online") : t("offline"), detail: gateway?.modelCount ? `${exposedModels.length} ${t("gateway-models-usable")}` : "等待模型端点", tone: gateway?.running && exposedModels.length ? "success" : "warning" })}</div>
    ${gatewayCard}
    <div class="agent-section-head"><div><h3>${t("roles-bindings")}</h3><p>${t("roles-section-lead")}</p></div><div class="c-segmented">${ui.badge(t(allEnabled ? "workers-enabled" : "workers-some-disabled"), allEnabled ? "success" : "neutral", { dot: true })}</div></div>
    <div id="agent-settings-list" class="c-list agent-role-list">${agentRows}</div>
    <p class="agent-role-note">${escape(t("workers-external-note"))}</p>
    <p class="agent-role-note">${escape(t("agents-note"))}</p>
  </div>`;
}
function selectedGatewayModel(current, models) {
  return models.some((model) => model.id === current) ? current : models[0]?.id || "";
}
async function refreshGateways({ announceFailure = false } = {}) {
  state.gatewayLoading = true;
  state.signatures.agentPage = "";
  renderAgentPage();
  try {
    const result = await api("/api/gateways");
    renderGateways(result.gateways || []);
  } catch (error) {
    if (announceFailure) announce(error.message, true);
  } finally {
    state.gatewayLoading = false;
    state.signatures.agentPage = "";
    renderAgentPage();
  }
}
async function useGatewayModel() {
  const model = $("gateway-model")?.value;
  if (!model) {
    announce(t("gateway-model-required"), true);
    return;
  }
  const button = document.querySelector("[data-gateway-apply]");
  if (button) button.disabled = true;
  try {
    const result = await api("/api/gateways/magpie/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (state.config?.config) {
      state.config.config.mainAgentBaseUrl = result.config?.mainAgentBaseUrl;
      state.config.config.mainAgentModel = result.config?.mainAgentModel;
    }
    await refresh({ preserveScroll: true });
    await refreshGateways();
    announce(t("gateway-model-applied"));
  } catch (error) {
    if (button) button.disabled = false;
    announce(error.message, true);
  }
}
async function clearGatewayModel() {
  try {
    await api("/api/gateways/magpie/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "" }),
    });
    await refresh({ preserveScroll: true });
    await refreshGateways();
    announce(t("gateway-model-cleared"));
  } catch (error) {
    announce(error.message, true);
  }
}
function renderSituation(situation, config) {
  state.situation = situation;
  state.config = config;
  const signature = JSON.stringify([situation, config]);
  if (state.signatures.situation === signature) {
    renderAgentPage();
    return;
  }
  state.signatures.situation = signature;
  const overdue = situation.overdue || [];
  const dueSoon = situation.dueSoon || [];
  const goals = situation.activeGoals || [];
  const boundaries = situation.selfModel || [];
  const rows = [];
  if (overdue.length) rows.push(`<div class="settings-card"><h4>已逾期 (${overdue.length})</h4>${overdue.slice(0, 6).map((item) => `<p>${escape(item.title)} · 应于 ${escape(String(item.dueAt || "").slice(0, 10))}</p>`).join("")}</div>`);
  if (dueSoon.length) rows.push(`<div class="settings-card"><h4>即将到期 (${dueSoon.length})</h4>${dueSoon.slice(0, 6).map((item) => `<p>${escape(item.title)} · ${escape(String(item.dueAt || "").slice(0, 10))}</p>`).join("")}</div>`);
  if (goals.length) rows.push(`<div class="settings-card"><h4>进行中的目标 (${goals.length})</h4>${goals.slice(0, 6).map((item) => `<p>${escape(item.title)}</p>`).join("")}</div>`);
  if (boundaries.length) rows.push(`<div class="settings-card"><h4>你声明过的边界 (${boundaries.length})</h4>${boundaries.slice(0, 6).map((item) => `<p>${escape(item.statement)}</p>`).join("")}</div>`);
  const observed = situation.observations || [];
  if (observed.length) rows.push(`<div class="settings-card"><h4>观察来源</h4>${observed.map((item) => `<p>${escape(item.connectorId)} · ${item.error ? `读取失败：${escape(item.error)}` : `${item.count} 条`}</p>`).join("")}</div>`);
  // Folders are long-term memory, not configuration: they are learned from the
  // owner's own requests, so this card is a record of use rather than a setting.
  // 文件夹是长期记忆而不是配置：它们从所有者自己的请求中学到，因此这张卡片是使用记录，不是设置。
  const folders = situation.folders || [];
  if (folders.length) {
    const stamp = (value) => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    };
    rows.push(`<div class="settings-card"><h4>分身记住的文件夹 (${folders.length})</h4>${folders.map((folder) => `<p><code>${escape(folder.path)}</code> · ${Number(folder.uses) || 0} 次请求 · 最近 ${escape(stamp(folder.lastUsedAt))}</p>`).join("")}<p class="agent-runtime-note">从你过去的请求中学到的长期记忆，不是设置；每回合开始都会带上这份记忆。</p></div>`);
  }
  $("situation-overview").innerHTML = rows.length
    ? rows.join("")
    : `<div class="memory-empty">还没有记录任何目标、承诺或观察。分身只会依据你确认过的内容行动。</div>`;
  const paths = config.paths || {};
  $("config-paths").innerHTML = `<h4>本地数据</h4><p>数据目录：${escape(paths.dataDirectory || "-")}</p><p>Provider 配置：${escape(paths.providersFile || "-")}</p><p>记忆：${escape(paths.memoryDirectory || "-")}</p><span class="settings-value">仅本机</span>`;
  renderComposerChoice();
  renderAgentPage();
}

/** Render the owner-facing phone binding state; secrets are deliberately never rendered. 渲染面向所有者的手机绑定状态；这里刻意不渲染任何秘密值。 */
function renderWhatsApp(status) {
  if (!status) return;
  state.whatsapp = status;
  const configured = status.configured === true;
  const bridgeRunning = status.bridge?.running === true;
  const tunnelRunning = status.tunnel?.running === true;
  const managedTunnel = status.tunnel?.managed === true;
  const tunnelUrl = status.tunnel?.webhookUrl || "";
  const verified = Boolean(status.bridge?.webhookVerifiedAt);
  const phone = status.phoneNumberId ? `Phone Number ID ${status.phoneNumberId}` : "还没有保存 Phone Number ID";
  if ($("mobile-state")) $("mobile-state").textContent = status.ready ? "已连接" : configured ? (bridgeRunning ? "待验证" : "已停止") : "未绑定";
  if ($("whatsapp-credential-state")) $("whatsapp-credential-state").textContent = configured ? "已保存" : "未配置";
  if ($("whatsapp-tunnel-state")) $("whatsapp-tunnel-state").textContent = managedTunnel ? "服务器入口" : tunnelRunning ? "运行中" : "未启动";
  if ($("whatsapp-ready-state")) $("whatsapp-ready-state").textContent = status.ready ? "已接通" : "等待配置";
  const allowed = Array.isArray(status.allowedNumbers) ? status.allowedNumbers : [];
  if (!state.whatsappDirty && $("whatsapp-allowed-numbers") && document.activeElement !== $("whatsapp-allowed-numbers")) {
    $("whatsapp-allowed-numbers").value = allowed.join(", ");
  }
  if (!state.whatsappDirty && $("whatsapp-phone-number-id") && document.activeElement !== $("whatsapp-phone-number-id")) {
    $("whatsapp-phone-number-id").value = status.phoneNumberId || "";
  }
  if (!state.whatsappDirty && $("whatsapp-verify-token") && document.activeElement !== $("whatsapp-verify-token")) {
    $("whatsapp-verify-token").value = status.verifyToken || "";
  }
  if ($("whatsapp-webhook-url")) $("whatsapp-webhook-url").textContent = tunnelUrl || "还没有公网地址";
  const install = $("whatsapp-install-cloudflared");
  if (install) install.hidden = managedTunnel || status.tunnel?.cloudflaredInstalled === true;
  if ($("whatsapp-start-tunnel")) $("whatsapp-start-tunnel").hidden = managedTunnel;
  if ($("whatsapp-stop-tunnel")) $("whatsapp-stop-tunnel").hidden = managedTunnel;
  if ($("whatsapp-start-tunnel")) $("whatsapp-start-tunnel").disabled = !configured || status.tunnel?.cloudflaredInstalled !== true || tunnelRunning;
  if ($("whatsapp-stop-tunnel")) $("whatsapp-stop-tunnel").disabled = !tunnelRunning;
  if ($("whatsapp-copy-webhook")) $("whatsapp-copy-webhook").disabled = !tunnelUrl;
  if ($("whatsapp-verify")) $("whatsapp-verify").disabled = !configured;
  if ($("whatsapp-stop-bridge")) $("whatsapp-stop-bridge").disabled = !bridgeRunning;
  if ($("whatsapp-tunnel-hint")) {
    $("whatsapp-tunnel-hint").textContent = status.tunnel?.error
      || (status.bridge?.stale
        ? "检测到旧版本手机桥仍在运行；点击“保存并启动手机桥”会安全地替换它。"
        : managedTunnel ? "服务器已经提供固定 HTTPS 入口；不需要在本机安装隧道工具。" : tunnelRunning ? "复制这个 HTTPS 地址 + /webhook 到 Meta；隧道地址通常会在重启后变化。" : status.tunnel?.cloudflaredInstalled ? "点击启动免费隧道，生成 Meta 可访问的地址。" : "还没有 cloudflared；可以在这里一键安装。");
  }
  if ($("whatsapp-verify-result")) $("whatsapp-verify-result").textContent = configured ? phone : "先填写四项凭据和一个手机号。";
  const overview = $("whatsapp-overview");
  if (overview) {
    overview.innerHTML = `<div class="mobile-status-card ${configured ? "is-ready" : ""}"><b>${configured ? "本机已保存绑定" : "还没有绑定手机"}</b><span>${escape(phone)}</span><span>${bridgeRunning ? "手机桥在线" : "手机桥未启动"} · ${tunnelRunning ? "公网入口在线" : "公网入口未启动"}</span>${status.bridge?.error ? `<span class="mobile-status-error">${escape(status.bridge.error)}</span>` : ""}</div>`;
  }
  const checklist = $("whatsapp-checklist");
  if (checklist) {
    const rows = [
      [configured, "填写 Cloud API 凭据和白名单号码"],
      [bridgeRunning, "手机桥在本机运行"],
      [tunnelRunning, "HTTPS Webhook 地址已生成"],
      [verified, "Meta 已成功验证 Webhook"],
      [Boolean(status.bridge?.lastMessageAt), status.bridge?.lastMessageAt ? `收到手机消息（${time(status.bridge.lastMessageAt)}）` : "从手机发一条 WhatsApp 做最终测试"],
    ];
    checklist.innerHTML = rows.map(([done, text]) => `<li class="${done ? "is-done" : ""}"><span>${done ? "✓" : "○"}</span>${escape(String(text))}</li>`).join("");
  }
}

async function refreshWhatsApp() {
  if (state.whatsappLoading) return;
  state.whatsappLoading = true;
  try {
    const result = await api("/api/mobile/whatsapp");
    renderWhatsApp(result.status);
  } catch (error) {
    announce(error.message, true);
  } finally {
    state.whatsappLoading = false;
  }
}

async function saveWhatsAppBinding() {
  const button = $("whatsapp-save");
  if (button) button.disabled = true;
  try {
    const result = await api("/api/mobile/whatsapp/binding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        allowedNumbers: $("whatsapp-allowed-numbers").value,
        phoneNumberId: $("whatsapp-phone-number-id").value,
        accessToken: $("whatsapp-access-token").value,
        appSecret: $("whatsapp-app-secret").value,
        verifyToken: $("whatsapp-verify-token").value,
      }),
    });
    $("whatsapp-access-token").value = "";
    $("whatsapp-app-secret").value = "";
    state.whatsappDirty = false;
    renderWhatsApp(result.status);
    announce("手机绑定已保存，手机桥已启动。");
  } catch (error) {
    announce(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function verifyWhatsAppBinding() {
  const button = $("whatsapp-verify");
  if (button) button.disabled = true;
  try {
    const result = await api("/api/mobile/whatsapp/verify", { method: "POST" });
    renderWhatsApp(result.status);
    const name = result.profile?.verifiedName || "Meta 号码";
    const phone = result.profile?.displayPhoneNumber || "";
    $("whatsapp-verify-result").textContent = `${name}${phone ? ` · ${phone}` : ""} 已验证`;
    announce("Meta 凭据验证通过。");
  } catch (error) {
    if ($("whatsapp-verify-result")) $("whatsapp-verify-result").textContent = error.message;
    announce(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function startWhatsAppTunnel() {
  const button = $("whatsapp-start-tunnel");
  if (button) { button.disabled = true; button.textContent = "正在启动…"; }
  try {
    const result = await api("/api/mobile/whatsapp/tunnel/start", { method: "POST" });
    renderWhatsApp(result.status);
    announce("公网 Webhook 地址已生成。");
  } catch (error) {
    announce(error.message, true);
    await refreshWhatsApp();
  } finally {
    if (button) { button.disabled = false; button.textContent = "启动免费隧道"; }
  }
}

async function installCloudflared() {
  if (!(await confirmDialog("这会用 Homebrew 安装 cloudflared。安装不会触碰 WhatsApp 凭据。继续吗？", "安装"))) return;
  const button = $("whatsapp-install-cloudflared");
  if (button) { button.disabled = true; button.textContent = "正在安装…"; }
  try {
    const result = await api("/api/mobile/whatsapp/tunnel/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acknowledgeInstall: true }),
    });
    renderWhatsApp(result.status);
    announce(result.installed ? "cloudflared 已安装。" : "安装命令结束，但仍未找到 cloudflared；请查看安装输出。");
  } catch (error) {
    announce(error.message, true);
  } finally {
    if (button) { button.disabled = false; button.textContent = "安装 cloudflared"; }
  }
}

async function stopWhatsAppTunnel() {
  try {
    const result = await api("/api/mobile/whatsapp/tunnel/stop", { method: "POST" });
    renderWhatsApp(result.status);
    announce("公网隧道已停止。");
  } catch (error) {
    announce(error.message, true);
  }
}

async function stopWhatsAppBridge() {
  const button = $("whatsapp-stop-bridge");
  if (button) button.disabled = true;
  try {
    const result = await api("/api/mobile/whatsapp/bridge/stop", { method: "POST" });
    renderWhatsApp(result.status);
    announce("手机桥已停止；保存的凭据仍然保留。");
  } catch (error) {
    announce(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

function generateWhatsAppVerifyToken() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  const input = $("whatsapp-verify-token");
  if (input) {
    input.value = token;
    state.whatsappDirty = true;
    input.focus();
    input.select();
  }
}

async function copyText(value, successMessage) {
  if (!value) {
    announce("还没有可复制的内容。", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    announce(successMessage);
  } catch {
    announce("复制失败，请手动选中文本复制。", true);
  }
}

function openMobileBinding() {
  closeSchedules();
  setSidebarOpen(false);
  state.settingsSection = "mobile";
  notifyDesktopNavigation("settings");
  openSettings();
  selectSettingsSection("mobile", true);
  void refreshWhatsApp();
}

function openMetaDeveloperConsole() {
  if (window.CloneNative?.openURL) {
    window.CloneNative.openURL("https://developers.facebook.com/apps/");
    return;
  }
  announce("当前窗口无法打开外部链接，请手动访问 developers.facebook.com/apps。", true);
}

async function loadModelOptions({ force = false } = {}) {
  if ((!force && state.modelOptionsLoaded) || state.modelOptionsLoading) return;
  state.modelOptionsLoading = true;
  try {
    const result = await api("/api/options");
    state.modelOptions = Array.isArray(result.models) ? result.models : [];
    state.modelOptionsLoaded = true;
    renderComposerChoice();
  } catch {
    // A catalog failure must not hide the rest of the composer.
    // 目录读取失败不应遮住输入框的其余部分。
    state.modelOptionsLoaded = true;
  } finally {
    state.modelOptionsLoading = false;
  }
}

function renderConnectors(connectors) { state.connectors = connectors; const signature = JSON.stringify(connectors); if (state.signatures.connectors === signature) return; state.signatures.connectors = signature; $("connector-list").innerHTML = connectors.length ? connectors.map((connector) => `<article class="agent-setting"><div><h3>${escape(connector.id)}</h3><p>${escape(connector.target || "（未设置目录）")}</p><small>只读观察，绝不获得执行权限</small></div><label class="agent-switch" title="${connector.enabled ? "停用此来源" : "启用此来源"}"><input type="checkbox" data-connector-toggle="${escape(connector.id)}" ${connector.enabled ? "checked" : ""}/><span></span></label><button class="schedule-toggle" type="button" data-connector-remove="${escape(connector.id)}">移除</button></article>`).join("") : `<div class="memory-empty">还没有观察来源。选一个笔记目录后，分身每轮开始时会读取其中的 .md / .txt 文件，把标题作为背景事实——它只能看，不能改也不能执行。</div>`; }

async function saveConnectors(connectors, message) { try { await api("/api/connectors", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectors }) }); await refresh(); announce(message); } catch (error) { announce(error.message, true); } }

function chooseNativeDirectory(purpose, onChoose) {
  if (window.CloneNative?.chooseDirectory) {
    window.CloneNative.onDirectoryChosen = (selectedPurpose, path) => {
      window.CloneNative.onDirectoryChosen = undefined;
      window.CloneNative.onDirectoryCancelled = undefined;
      if (selectedPurpose === purpose) void onChoose(path);
    };
    window.CloneNative.onDirectoryCancelled = () => {
      window.CloneNative.onDirectoryChosen = undefined;
      window.CloneNative.onDirectoryCancelled = undefined;
    };
    window.CloneNative.chooseDirectory(purpose);
    return;
  }
  announce(t("directory-native-only"), true);
}

/* ---------- Authority and owner-data export ---------- */
const AUTHORITY_DEFAULT_LEVEL = "allow_all";
const AUTHORITY_DOMAINS = [
  ["files", "文件", "读取或写入文件与目录"],
  ["shell", "Shell 命令", "在本机执行命令前缀，例如 git"],
  ["network", "网络", "访问主机名或 *"],
];
const AUTHORITY_LEVELS = [
  ["act_with_approval", "批准"],
  ["act_auto", "自动执行"],
  ["allow_all", "全部放行"],
];
// Old configs and the corrupt-file fail-closed value may still hold these; the
// owner sees them only when one is selected, and can replace it with a visible level.
// 旧配置与损坏文件的 fail-closed 值仍可能保存它们；只有当前值是其一时才显示，所有者可换成
// 可见档位。
const AUTHORITY_LEGACY_LEVELS = [
  ["observe", "旧配置：只读"],
  ["prepare", "旧配置：可准备"],
];
const AUTHORITY_LEVEL_HINTS = {
  observe: "旧配置：写入与执行被拒绝；读取不受限。",
  prepare: "旧配置：写入与执行需要你确认。",
  act_with_approval: "带 Scope 的写入与执行需要你确认；读取不受限。",
  act_auto: "模型点名 Scope 后直接执行；受保护位置拒绝，外部/不可逆仍会停下。",
  allow_all: "不再要求 Scope，外部/不可逆不再确认；受保护位置仍拒绝。",
};
const AUTHORITY_ACCESS = [["read", "读取"], ["write", "写入"], ["exec", "执行"]];

function authorityLevelOptions(selected) {
  const legacy = AUTHORITY_LEGACY_LEVELS.find(([value]) => value === selected);
  const options = legacy === undefined ? AUTHORITY_LEVELS : [...AUTHORITY_LEVELS, legacy];
  return options.map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`).join("");
}

function renderAuthority() {
  const host = $("authority-root");
  if (!host || !state.authority) return;
  const domains = state.authority.domains || {};
  const policies = (state.authority.policies || []).filter((policy) => policy.revokedAt === undefined);
  const domainRows = AUTHORITY_DOMAINS.map(([domain, title, detail]) => {
    const level = domains[domain] || AUTHORITY_DEFAULT_LEVEL;
    const label = AUTHORITY_LEVELS.find(([value]) => value === level)?.[1] || level;
    return `<article class="agent-setting"><div><h3>${title}</h3><p>${detail}</p><small>当前：${escape(label)} · ${escape(AUTHORITY_LEVEL_HINTS[level] || "")}</small></div><select data-authority-domain="${domain}" aria-label="${title}的自主档位">${authorityLevelOptions(level)}</select></article>`;
  }).join("");
  const policyRows = policies.length
    ? policies.map((policy) => `<article class="memory-card"><div class="memory-meta"><span>${escape(policy.label)}</span><span>最高 ${escape(AUTHORITY_LEVELS.find(([value]) => value === policy.maxAutonomy)?.[1] || policy.maxAutonomy)}</span></div><p class="context-summary">${policy.scopes.map((scope) => `${escape(scope.domain)}:${escape(scope.access)}:${escape(scope.resource)}`).join(" · ")}</p><small>${policy.validUntil ? `有效至 ${escape(policy.validUntil)}` : "长期有效"} · ${escape(policy.id)}</small><div class="memory-tool-row"><button class="secondary" type="button" data-authority-revoke="${escape(policy.id)}">撤销</button></div></article>`).join("")
    : `<div class="memory-empty">没有常设策略。自动执行不需要策略；常设策略只用于进一步收紧某个 Scope。</div>`;
  const decisions = (state.authorityDecisions || []).slice(0, 20)
    .map((event) => `<li><time>${escape(String(event.occurredAt || "").slice(0, 16).replace("T", " "))}</time><span>${escape(event.type)}</span></li>`).join("");
  host.innerHTML = `<div class="authority-grid">${domainRows}</div>
    <details class="authority-advanced">
      <summary>高级：常设策略（可选）</summary>
      <p class="agent-runtime-note">不配置也能正常使用。策略在它覆盖的 Scope 内生效；同一 Scope 被多条策略覆盖时，最低的上限生效。</p>      <div class="memory-list">${policyRows}</div>
      <form id="authority-policy-form" class="authority-form">
        <h4>新增常设策略</h4>
        <div class="memory-tool-row"><input id="authority-policy-label" type="text" placeholder="用途说明，例如：只允许整理下载目录" aria-label="策略用途"/></div>
        <div class="memory-tool-row">
          <select id="authority-policy-domain" aria-label="域">${AUTHORITY_DOMAINS.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select>
          <select id="authority-policy-access" aria-label="访问方式">${AUTHORITY_ACCESS.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select>
          <input id="authority-policy-resource" type="text" placeholder="资源：绝对路径 / 命令前缀 / 主机名" aria-label="资源"/>
        </div>
        <div class="memory-tool-row">
          <select id="authority-policy-max" aria-label="最高档位">${authorityLevelOptions("act_with_approval")}</select>
          <input id="authority-policy-until" type="date" aria-label="有效期至（可选）"/>
          <button class="primary" type="submit">添加策略</button>
        </div>
      </form>
    </details>
    ${decisions ? `<details class="authority-decisions"><summary>最近的权限判定（${Math.min(state.authorityDecisions.length, 20)} 条）</summary><ul class="au-history">${decisions}</ul></details>` : ""}`;
}

async function refreshAuthority() {
  if (state.authorityLoading) return;
  state.authorityLoading = true;
  try {
    const [config, decisions] = await Promise.all([
      api("/api/authority"),
      api("/api/authority/decisions").catch(() => ({ events: [] })),
    ]);
    state.authority = config.config;
    state.authorityDecisions = decisions.events || [];
    renderAuthority();
  } catch (error) {
    const host = $("authority-root");
    if (host) host.innerHTML = `<p class="memory-empty">读取权限失败：${escape(error.message)}</p>`;
  } finally {
    state.authorityLoading = false;
  }
}

async function setAuthorityDomain(domain, level) {
  try {
    const result = await api("/api/authority/domains", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ domain, level }) });
    state.authority = result.config;
    renderAuthority();
    announce(`${domain} 的自主档位已更新。`);
    void refreshAuthority();
  } catch (error) { announce(error.message, true); }
}

async function revokeAuthorityPolicy(id) {
  if (!(await confirmDialog("撤销这条常设策略？撤销后，它覆盖的动作回到当前域档位（默认自动执行）。", "撤销"))) return;
  try {
    await api(`/api/authority/policies/${encodeURIComponent(id)}`, { method: "DELETE" });
    announce("策略已撤销。");
    await refreshAuthority();
  } catch (error) { announce(error.message, true); }
}

async function addAuthorityPolicy(form) {
  const label = $("authority-policy-label").value.trim();
  const domain = $("authority-policy-domain").value;
  const access = $("authority-policy-access").value;
  const resource = $("authority-policy-resource").value.trim();
  const maxAutonomy = $("authority-policy-max").value;
  const until = $("authority-policy-until").value;
  if (resource.length === 0) { announce("请填写策略覆盖的资源。", true); return; }
  const body = {
    label: label || `${domain} ${access} ${resource}`,
    scopes: [{ domain, access, resource }],
    maxAutonomy,
    ...(until ? { validUntil: new Date(`${until}T23:59:59`).toISOString() } : {}),
  };
  try {
    await api("/api/authority/policies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    form.reset();
    announce("策略已添加。");
    await refreshAuthority();
  } catch (error) { announce(error.message, true); }
}

async function exportOwnerDataFromDesktop() {
  chooseNativeDirectory("export", async (destination) => {
    const button = $("data-export-choose");
    if (button) button.disabled = true;
    $("data-export-status").textContent = "正在导出…";
    try {
      const result = await api("/api/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ destination }) });
      state.exportDestination = result.destination;
      $("data-export-path").textContent = result.destination;
      $("data-export-reveal").hidden = false;
      $("data-export-status").textContent = `${result.summary}${result.excludes?.length ? ` 跳过：${result.excludes.join("；")}` : ""}`;
      announce("数据已导出。");
    } catch (error) {
      $("data-export-status").textContent = "";
      announce(error.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  });
}

function revealExport() {
  if (!state.exportDestination) return;
  if (window.CloneNative?.revealInFinder) {
    window.CloneNative.revealInFinder(state.exportDestination);
    return;
  }
  announce(t("directory-native-only"), true);
}

/**
 * Saves one rendered table as CSV, the file Excel opens directly. The desktop
 * keeps the write on the daemon, after the owner picks a folder; a browser
 * preview has no native picker, so it falls back to a download.
 * 把一张已渲染的表格保存为 Excel 可直接打开的 CSV。桌面端在所有者在原生选择器里挑中
 * 文件夹后，由 daemon 完成写入；浏览器预览没有原生选择器，回退为下载。
 */
function exportMarkdownTable(csv) {
  if (!csv.trim()) { announce("这张表没有可导出的内容。", true); return; }
  const payload = String.fromCharCode(0xFEFF) + csv;
  if (!window.CloneNative?.chooseDirectory) {
    const blob = new Blob([payload], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `clone-ai-table-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    announce("表格已下载为 CSV。");
    return;
  }
  chooseNativeDirectory("table-export", async (destination) => {
    try {
      const result = await api("/api/tables/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ destination, csv: payload }),
      });
      if (window.CloneNative?.revealInFinder) window.CloneNative.revealInFinder(result.path);
      announce(`表格已导出：${result.name}`);
    } catch (error) { announce(error.message, true); }
  });
}

async function addConnector() {
  chooseNativeDirectory("connector", async (target) => {
    const existing = state.connectors || [];
    if (existing.some((connector) => connector.target === target)) {
      announce(t("connector-duplicate"));
      return;
    }
    const id = `files:${Date.now().toString(36)}`;
    await saveConnectors([...existing, { id, enabled: true, target }], t("connector-added"));
  });
}

async function setConnectorEnabled(id, enabled) { const next = (state.connectors || []).map((connector) => connector.id === id ? { ...connector, enabled } : connector); await saveConnectors(next, enabled ? "观察来源已启用。" : "观察来源已停用。"); }

async function removeConnector(id) { await saveConnectors((state.connectors || []).filter((connector) => connector.id !== id), "观察来源已移除。"); }

/** Selectable Main Agent models, deduplicated and labeled like the Settings picker. 可选的 Main Agent 模型，去重并按设置页的方式标注。 */
function selectableModels() {
  const models = [];
  const seen = new Set();
  for (const model of state.modelOptions || []) {
    if (!model?.reference || seen.has(model.reference)) continue;
    seen.add(model.reference);
    const label = String(model.label || model.id || model.reference);
    const provider = String(model.provider || "");
    models.push({
      value: model.reference,
      label: `${label}${provider && provider !== "magpie" && !label.includes(provider) ? ` · ${provider}` : ""}`,
    });
  }
  return models;
}

/**
 * Known reasoning-effort names, in the provider's spelling.
 *
 * The gateway declares levels per model, but it also accepts names it does not
 * list: a direct probe against the local gateway with `deepseek-v4.1-flash`
 * returned HTTP 200 for `medium`, `minimal`, `xhigh`, `ultra`, `none` and
 * `off`. The picker therefore offers the model's declared levels first and the
 * rest of this vocabulary under a marked group, instead of hiding levels the
 * provider accepts.
 * 已知推理强度名称，采用 Provider 的写法。
 *
 * 网关逐模型声明档位，但也接受未列出的名称：用 `deepseek-v4.1-flash` 直接探测本地网关，
 * `medium`、`minimal`、`xhigh`、`ultra`、`none`、`off` 都返回 HTTP 200。因此选择器先列
 * 模型声明的档位，再把其余词汇放在带标记的分组里，而不是藏起 Provider 接受的档位。
 */
const EFFORT_LEVELS = ["none", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const EFFORT_LEVEL_KEYS = {
  none: "effort-level-none",
  off: "effort-level-off",
  minimal: "effort-level-minimal",
  low: "effort-level-low",
  medium: "effort-level-medium",
  high: "effort-level-high",
  xhigh: "effort-level-xhigh",
  max: "effort-level-max",
  ultra: "effort-level-ultra",
};

/** A level as the owner reads it, with the exact name sent to the provider. 所有者读到的档位，附带真正发送给 Provider 的名称。 */
function effortLevelLabel(level) {
  const key = EFFORT_LEVEL_KEYS[level];
  const label = key ? t(key) : "";
  return label && label !== key ? `${label} · ${level}` : level;
}

/** The levels the gateway actually declares for this model; empty when it declares none. 网关为该模型实际声明的档位；未声明时为空。 */
function declaredReasoningLevelsFor(model) {
  const id = String(model || state.config?.config?.mainAgentModel || "");
  const gateway = state.gateways.find((candidate) => candidate.id === "magpie");
  const declared = (gateway?.models || []).find((entry) => entry.id === id)?.reasoningLevels;
  return Array.isArray(declared) && declared.length > 0 ? declared : [];
}

/**
 * The effort picker's groups: what the model declares, then every other known
 * level. A gateway that declares nothing gets one honest "known levels" group
 * rather than a fake declaration.
 * 强度选择器的分组：模型声明的档位，然后是其余已知档位。网关什么都没声明时，只给一个
 * 诚实的"已知档位"组，而不是伪造一份声明。
 */
function effortLevelGroupsFor(model) {
  const declared = declaredReasoningLevelsFor(model);
  if (declared.length === 0) return [{ label: t("effort-group-known"), levels: EFFORT_LEVELS }];
  const others = EFFORT_LEVELS.filter((level) => !declared.includes(level));
  return [
    { label: t("effort-group-declared"), levels: declared },
    ...(others.length === 0 ? [] : [{ label: t("effort-group-other"), levels: others }]),
  ];
}

/* ---------- Composer model and effort, saved with the conversation ---------- */
const TURN_CHOICE_STORAGE = "clone-ai:turn-choice:";

/**
 * The conversation the composer currently speaks to. Empty means a new
 * request, which the router has not bound to a conversation yet.
 * 输入框当前对应的对话。空值表示尚未路由到对话的新请求。
 */
function activeConversationId() {
  if (state.composingNew) return "";
  if (state.selectedId === MAIN_CONVERSATION_ID) return MAIN_CONVERSATION_ID;
  const selected = (state.dashboard?.sessions || []).find((session) => session.id === state.selectedId);
  if (selected?.kind === "conversation") return selected.id;
  return selected?.conversationId ?? selected?.parentId ?? "";
}

function readTurnChoice(conversationId) {
  // The daemon's per-conversation record is the source of truth: localStorage
  // is scoped to the ephemeral 127.0.0.1 port and disappears when the daemon
  // restarts. It stays only as a cache for a request not yet bound to a chat.
  // 守护进程的每对话记录是事实来源：localStorage 按临时 127.0.0.1 端口隔离，Daemon 重启
  // 就会消失。它只作为尚未绑定对话的新请求的缓存。
  const served = conversationId ? state.turnChoices[conversationId] : undefined;
  if (served && (served.model || served.effort)) {
    return { model: served.model || "", effort: served.effort || "" };
  }
  try {
    const stored = JSON.parse(localStorage.getItem(`${TURN_CHOICE_STORAGE}${conversationId || "new"}`) || "{}");
    return {
      model: typeof stored.model === "string" ? stored.model : "",
      effort: typeof stored.effort === "string" ? stored.effort : "",
    };
  } catch {
    return { model: "", effort: "" };
  }
}

function writeTurnChoice(conversationId, choice) {
  const key = `${TURN_CHOICE_STORAGE}${conversationId || "new"}`;
  if (!choice.model && !choice.effort) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify({ model: choice.model || "", effort: choice.effort || "" }));
  if (!conversationId) return;
  if (choice.model || choice.effort) state.turnChoices[conversationId] = { model: choice.model || "", effort: choice.effort || "" };
  else delete state.turnChoices[conversationId];
  void api("/api/main-agent/turn-choice", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId, model: choice.model || "", effort: choice.effort || "" }),
  }).catch(() => undefined);
}

/** Fill a missing choice from the daemon when a conversation is opened directly. 直接打开对话时从守护进程补齐缺失的选择。 */
async function hydrateTurnChoice(conversationId) {
  if (!conversationId || state.turnChoices[conversationId]) return;
  try {
    const result = await api(`/api/main-agent/turn-choice?conversationId=${encodeURIComponent(conversationId)}`);
    if (result.choice && (result.choice.model || result.choice.effort)) {
      state.turnChoices[conversationId] = result.choice;
      renderComposerChoice();
    }
  } catch {
    // The composer falls back to its local cache. 输入框回退到本地缓存。
  }
}

/** The effort select's full option list. A saved level outside the offered groups still appears as the current choice. 强度选择器的完整选项列表；已保存但不在提供范围内的档位仍作为当前选择出现。 */
function effortOptionsMarkup(groups, choice) {
  const offered = groups.flatMap((group) => group.levels);
  const outside = choice && !offered.includes(choice)
    ? `<option value="${escape(choice)}">${escape(choice)} · ${escape(t("composer-choice-current"))}</option>`
    : "";
  const body = groups.map((group) => `<optgroup label="${escape(group.label)}">${group.levels.map((level) => `<option value="${escape(level)}">${escape(effortLevelLabel(level))}</option>`).join("")}</optgroup>`).join("");
  return `<option value="">${escape(t("effort-default"))}</option>${outside}${body}`;
}

/** Render the composer pickers from the saved choice; empty means "follow Settings". 按保存的选择渲染输入框选择器；空值表示"跟随设置"。 */
function renderComposerChoice() {
  const modelSelect = $("composer-model");
  const effortSelect = $("composer-effort");
  if (!modelSelect || !effortSelect) return;
  const choice = readTurnChoice(activeConversationId());
  const models = selectableModels();
  const modelSignature = JSON.stringify([models, choice.model, state.locale]);
  if (modelSelect.dataset.signature !== modelSignature) {
    modelSelect.dataset.signature = modelSignature;
    const outsideCatalog = choice.model && !models.some((model) => model.value === choice.model)
      ? `<option value="${escape(choice.model)}">${escape(choice.model)} · ${escape(t("composer-choice-current"))}</option>`
      : "";
    modelSelect.innerHTML = `<option value="">${escape(t("composer-default"))}</option>${outsideCatalog}${models.map((model) => `<option value="${escape(model.value)}">${escape(model.label)}</option>`).join("")}`;
    // Rebuilding the options resets the selection to the first one; restore the
    // saved choice even while the select is focused.
    // 重建选项会把选中项重置为第一项；即使选择器处于聚焦状态也要恢复已保存的选择。
    modelSelect.value = choice.model;
  } else if (document.activeElement !== modelSelect) {
    modelSelect.value = choice.model;
  }
  const effortGroups = effortLevelGroupsFor(choice.model);
  const effortSignature = JSON.stringify([effortGroups, choice.effort, state.locale]);
  if (effortSelect.dataset.signature !== effortSignature) {
    effortSelect.dataset.signature = effortSignature;
    effortSelect.innerHTML = effortOptionsMarkup(effortGroups, choice.effort);
    effortSelect.value = choice.effort;
  } else if (document.activeElement !== effortSelect) {
    effortSelect.value = choice.effort;
  }
  // An undeclared level is a request, not a guarantee: say so in the closed
  // control, where the group label is no longer visible. A model that declares
  // nothing also gets the note, for the same reason.
  // 未声明的档位是请求，不是保证：在分组标签已不可见的闭合态里说明这一点。什么都没
  // 声明的模型也应显示提示，理由相同。
  const caveat = $("composer-effort-caveat");
  if (caveat) {
    const declared = declaredReasoningLevelsFor(choice.model);
    caveat.hidden = !choice.effort || declared.includes(choice.effort);
  }
}

/** Persist a picker change for the current conversation. The effort select only
 * offers known values plus the saved current choice, so saving it as rendered
 * cannot silently clear a mapped level. 保存选择器改动；强度选择器只会提供已知值与已保存的
 * 当前选择，因此按渲染值保存不会悄悄清掉映射档位。 */
function saveComposerChoice() {
  const model = $("composer-model")?.value || "";
  const effort = $("composer-effort")?.value || "";
  writeTurnChoice(activeConversationId(), { model, effort });
  renderComposerChoice();
}

async function saveLocale() {
  const locale = $("config-locale")?.value;
  if (locale !== "zh-CN" && locale !== "en") return;
  try {
    await api("/api/config", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale }) });
    await refresh({ preserveScroll: true });
  } catch (error) { announce(error.message, true); }
}

function renderAudit(sessions) {
  // The audit list is execution records; a conversation row is a request, not
  // a Run, and belongs in the sidebar and the 主 Agent 回合 tab instead.
  // 审计列表是执行记录；对话行是请求而不是 Run，属于侧栏与"主 Agent 回合"页。
  const records = sessions.filter((session) => session.kind !== "conversation");
  const signature = JSON.stringify(records.map((session) => [session.id, session.title, session.status, session.updatedAt])); if (state.signatures.audit === signature) return; state.signatures.audit = signature; $("audit-session-list").innerHTML = records.length ? records.map((session) => `<article class="audit-session"><div><b>${escape(session.title)}</b><span>${escape(statusMeta(session.status).label)} · ${time(session.updatedAt)}</span></div><button class="audit-open" type="button" data-open-audit-run="${escape(session.id)}">查看记录</button></article>`).join("") : `<div class="memory-empty">还没有可查看的执行记录。</div>`;
}
function renderMemoryCandidates(candidates) {
  if (!candidates || !candidates.length) { $("memory-candidates").innerHTML = ""; return; }
  $("memory-candidates").innerHTML = `<h4>待确认的记忆候选（${candidates.length}）</h4><p class="candidates-hint">配置的记忆提炼器从任务证据或对话中提出了这些候选；提升后会写入本地记忆库，拒绝则丢弃。</p>${candidates.map((candidate) => `<article class="memory-card candidate-card"><textarea readonly aria-label="候选记忆内容">${escape(candidate.summary)}</textarea><div class="memory-meta"><span>${escape(candidate.type || "fact")} · ${escape(candidate.confidence)} 置信度</span>${candidate.sensitivity ? `<span>${escape(candidate.sensitivity)}</span>` : ""}<span>引用 ${(candidate.sourceEvidenceIds || []).length} 条证据</span></div><div class="candidate-actions"><button class="approve" type="button" data-promote-candidate="${escape(candidate.id)}">提升为记忆</button><button class="secondary" type="button" data-reject-candidate="${escape(candidate.id)}">拒绝</button></div></article>`).join("")}`;
}
async function decideCandidate(id, action) { try { await api(`/api/memory/candidates/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); await refresh(); announce(action === "promote" ? "候选已提升为正式记忆。" : "候选已拒绝。"); } catch (error) { announce(error.message, true); } }
function renderMemorySearch(results) { $("memory-search-results").innerHTML = results.length ? results.map((match) => `<article class="memory-match"><div><b>${escape(match.summary)}</b><small>匹配：${escape((match.matchedTerms || []).join("、") || "相关上下文")}</small></div><span>${Math.round(match.score * 100)}%</span></article>`).join("") : `<div class="memory-empty">没有找到会被当前检索规则召回的使用中记忆。分身和子 Agent 看到的就是这些结果。</div>`; }

/**
 * The opportunity strip: what the twin noticed without being asked.
 *
 * Cards render above the conversation, not buried in a settings panel —
 * "the twin proactively found you" has to mean you see it where you already
 * are. Accept creates a run (the backend plans and queues it); dismiss
 * removes the card. Both record the decision in the journal.
 *
 * 机会卡片：分身不等人提问时发现的东西。
 *
 * 卡片渲染在对话区上方，而不是埋在设置面板里——“分身主动找你”必须意味着你在
 * 本来就在的地方看到它。接受会创建 Run（后端会规划并入队）；拒绝会移除卡片。
 * 两个决定都记入 Journal。
 */
// A failure card's next action is diagnosis, not another blind run. Repeating
// "accept" created a trail of identical failed sessions and never surfaced why.
// 失败卡片的下一步是诊断，而不是再盲目跑一遍。重复“接受”只会堆出相同失败会话，
// 却从不把原因告诉所有者。
function isFailureCard(card) {
  return card.source === "failed_task";
}

const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/;
function normalizedCopy(value) { return String(value ?? "").replace(/[。！？!?.]+$/g, "").trim(); }

/** The failure title without the source prefix its chip already names. 去掉芯片已经点名的来源前缀后的失败标题。 */
function failureTitleText(card) {
  return plainPreview(card.title).replace(/^任务需要跟进[：:]\s*/, "").trim();
}

/**
 * The failure card's why-line, said once: the raw ISO timestamp becomes the
 * owner's local date and time, and the trailing sentence that merely restates
 * the title is dropped only when it matches exactly. Any structure the helper
 * does not recognise is kept as written — the card is a diagnostic entry, not
 * a place to rewrite server prose.
 * 失败卡的 why 行只说一遍：原始 ISO 时间变成所有者的本地日期时间；只有与标题完全相同的
 * 结尾复述才删除。助手不认识的任何结构都原样保留——卡片是诊断入口，不是改写后端散文的地方。
 */
function failureWhyText(card) {
  const raw = plainPreview(card.whyNow);
  if (!raw.trim()) return "";
  const withTime = raw.replace(ISO_TIMESTAMP_PATTERN, (match) => {
    const date = new Date(match);
    if (Number.isNaN(date.getTime())) return match;
    return new Intl.DateTimeFormat(state.locale || "zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  });
  const title = normalizedCopy(failureTitleText(card));
  const sentences = withTime.split("。");
  // A sentence-ending "。" leaves an empty trailing segment; drop it before
  // looking at the last real sentence, or a repeated tail is never seen.
  // 句末的"。"会留下空的尾段；先去掉它，再检查最后一句，否则复述永远看不到。
  while (sentences.length > 0 && !sentences[sentences.length - 1]?.trim()) sentences.pop();
  const last = sentences[sentences.length - 1]?.trim() ?? "";
  if (sentences.length > 1 && last && normalizedCopy(last) === title) sentences.pop();
  const joined = sentences.join("。").trim();
  if (!joined || normalizedCopy(joined) === title) return "";
  return /[。！？!?]$/.test(joined) ? joined : `${joined}。`;
}

function opportunityCardMarkup(card) {
  const failed = isFailureCard(card);
  // The chip already says 任务跟进; keeping the same prefix in the title makes
  // every failure card say it twice.
  // 芯片已经写着“任务跟进”；标题里再保留同样前缀会让每条失败卡说两遍。
  const title = failed ? failureTitleText(card) : plainPreview(card.title);
  const why = failed ? failureWhyText(card) : plainPreview(card.whyNow);
  return `<article class="opportunity-card${failed ? " is-failure" : ""}">
      <div class="opportunity-icon" aria-hidden="true">${failed ? "!" : "✦"}</div>
      <div class="opportunity-copy">
        <div class="opportunity-head"><span class="opportunity-source">${escape(opportunitySourceLabel(card.source))}</span><b>${escape(title)}</b></div>
        ${why ? `<p class="opportunity-why">${escape(why)}</p>` : ""}
        <p class="opportunity-proposal">${escape(plainPreview(card.proposedResult))}</p>
      </div>
      <div class="opportunity-actions">
        <button class="approve" type="button" data-accept-opportunity="${escape(card.id)}">${failed ? "查看原因" : "开始处理"}</button>
        ${failed ? `<button class="secondary" type="button" data-open-failure-settings>Agent 设置</button>` : ""}
        <button class="opportunity-dismiss" type="button" data-dismiss-opportunity="${escape(card.id)}">忽略</button>
      </div>
    </article>`;
}

/**
 * A backlog of failed tasks is one status row, not a stack of identical
 * notices: three cards occupied 205 px of a 1080 px window before the
 * conversation started. The row names the count and the newest failure;
 * expanding restores the cards and their actions. A single failure still
 * shows its card — one alert is information, a wall of them is noise.
 * 一堆失败任务是状态行，不是一叠相同的通知：三张卡片在 1080px 窗口里占掉 205px，对话还
 * 没开始。状态行写明条数与最新一条；展开后恢复卡片与操作。单条失败仍显示卡片——一条是
 * 信息，一堵墙是噪音。
 */
function opportunitiesMarkup(cards, expanded) {
  const failures = cards.filter(isFailureCard);
  const others = cards.filter((card) => !isFailureCard(card));
  const collapsed = failures.length > 1 && !expanded;
  const newest = failures[0];
  // The card title repeats the source label ("任务需要跟进：…"); the summary
  // already names the group, so only the specific failure remains.
  // 卡片标题重复了来源标签（"任务需要跟进：…"）；摘要已经点名分组，所以只留具体失败。
  const newestTitle = newest ? failureTitleText(newest) : "";
  const summary = failures.length > 1
    ? `<button class="opportunity-summary" type="button" data-toggle-opportunities aria-expanded="${expanded ? "true" : "false"}" aria-controls="opportunity-failure-cards">
        <span class="opportunity-icon" aria-hidden="true">!</span>
        <span class="opportunity-summary-copy"><b>任务跟进</b><span>${failures.length} 条待处理${newestTitle ? ` · 最新：${escape(newestTitle)}` : ""}</span></span>
        <span class="opportunity-summary-action">${expanded ? "收起" : "展开"}</span>
      </button>`
    : "";
  // Non-failure opportunities stay visible: a deadline is something to act on,
  // not backlog. Failure cards are always in the DOM so aria-controls resolves
  // and toggling can flip `hidden` in place without moving keyboard focus;
  // a long backlog scrolls instead of pushing the conversation off-screen.
  // 非失败机会始终可见：临近承诺是要行动的事，不是积压。失败卡始终在 DOM 中，这样
  // aria-controls 有目标，切换时可以原地翻转 `hidden` 而不会丢掉键盘焦点；过长的积压
  // 在卡片区内滚动，而不是把对话顶出屏幕。
  const otherCards = others.length
    ? `<div class="opportunity-cards">${others.slice(0, 4).map(opportunityCardMarkup).join("")}</div>`
    : "";
  const failureCards = failures.length
    ? `<div class="opportunity-cards opportunity-cards--failures" id="opportunity-failure-cards"${collapsed ? " hidden" : ""}>${failures.map(opportunityCardMarkup).join("")}</div>`
    : "";
  return `${summary}${otherCards}${failureCards}`;
}

function toggleOpportunities() {
  const expanded = !state.opportunitiesExpanded;
  state.opportunitiesExpanded = expanded;
  const summary = $("opportunity-strip").querySelector("[data-toggle-opportunities]");
  const failureCards = $("opportunity-failure-cards");
  if (!summary || !failureCards) return;
  summary.setAttribute("aria-expanded", expanded ? "true" : "false");
  const action = summary.querySelector(".opportunity-summary-action");
  if (action) action.textContent = expanded ? "收起" : "展开";
  failureCards.hidden = !expanded;
  // Keep the refresh's signature in step with the DOM change it just made.
  // 让刷新使用的签名与刚刚完成的 DOM 变更保持一致。
  state.signatures.opportunities = JSON.stringify([state.opportunities || [], expanded]);
}

function renderOpportunities(cards) {
  state.opportunities = cards;
  const signature = JSON.stringify([cards, state.opportunitiesExpanded]);
  if (state.signatures.opportunities === signature) return;
  state.signatures.opportunities = signature;
  const strip = $("opportunity-strip");
  if (!cards.length) {
    state.opportunitiesExpanded = false;
    strip.hidden = true;
    strip.innerHTML = "";
    return;
  }
  // A background refresh can replace the strip while the summary holds focus;
  // give the new summary the focus back so the keyboard is not dropped on body.
  // 后台刷新可能在摘要持有焦点时换掉整条；把焦点还给新摘要，别让键盘落回 body。
  const restoreFocus = document.activeElement instanceof Element && document.activeElement.closest("[data-toggle-opportunities]") !== null;
  strip.hidden = false;
  strip.innerHTML = opportunitiesMarkup(cards, state.opportunitiesExpanded);
  if (restoreFocus) strip.querySelector("[data-toggle-opportunities]")?.focus();
}

function opportunitySourceLabel(source) { return { deadline: "临近承诺", failed_task: "任务跟进", neglected_goal: "目标提醒", observation: "新观察" }[source] || "机会"; }

async function decideOpportunity(id, action) {
  try {
    const card = (state.opportunities || []).find((candidate) => candidate.id === id);
    if (action === "accept" && card && isFailureCard(card)) {
      const result = await api(`/api/opportunities/${encodeURIComponent(id)}/accept`, { method: "POST" });
      state.signatures.opportunities = null;
      await refresh({ scrollToBottom: false });
      if (result.runId) void selectSession(result.runId);
      announce(result.inspectOnly ? "已打开失败记录；请查看原因后再决定重试。" : "已记录这个决定。");
      return;
    }
    const result = await api(`/api/opportunities/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    state.signatures.opportunities = null;
    await refresh({ scrollToBottom: false });
    announce(action === "accept" ? `已接受。任务 ${String(result.runId || "").slice(0, 8)} 已开始准备。` : "已记录这个决定。");
  } catch (error) { announce(error.message, true); }
}

const MEMORY_TYPES = [["preference", "偏好"], ["fact", "事实"], ["decision", "决定"], ["procedure", "流程"], ["commitment", "承诺"]];
const MEMORY_SENSITIVITIES = [["private", "私有"], ["public", "公开"], ["secret", "机密"]];
function options(pairs, selected) { return pairs.map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join(""); }

function renderLibrary(library) {
  state.library = library;
  // Never redraw a field the owner is typing into: the .md content is
  // long-form prose, and losing a half-written paragraph to a background poll
  // is the fastest way to make an editor untrustworthy. The guard is limited
  // to text entry — a focused button is not an edit in progress, and treating
  // it as one would freeze the panel until the owner clicked elsewhere.
  const activeElement = document.activeElement;
  const editing = activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement;
  if (editing && activeElement.closest("#library-list, #library-new-content, #library-new-summary, .memory-tools")) return;
  const signature = JSON.stringify(library);
  if (state.signatures.library === signature) return;
  state.signatures.library = signature;
  const stats = library.stats || { active: 0, archived: 0, total: 0, pending: 0, contentDirectory: "" };
  $("library-overview").innerHTML = `<button type="button" class="memory-stat" data-memory-filter="active" aria-pressed="false"><b>${stats.active}</b><span>使用中</span></button><button type="button" class="memory-stat" data-memory-filter="archived" aria-pressed="false"><b>${stats.archived}</b><span>已归档</span></button><button type="button" class="memory-stat" data-memory-focus="memory-candidates"><b>${stats.pending}</b><span>待确认候选</span></button><article class="memory-stat file-stat"><b>.md</b><span>${escape(stats.contentDirectory || "-")}</span></article>`;
  const memories = library.memories || [];
  const conflicts = (library.conflicts || []).map((item) => `<article class="memory-card"><b>${escape(t("memory-conflict"))}</b><p>${escape(item.summary)}</p><button class="secondary" type="button" data-memory-conflict="${escape(item.id)}">${escape(t("memory-keep-file"))}</button></article>`).join("");
  const cards = memories.length ? memories.map((item) => `<article class="memory-card library-card" data-library-card="${escape(item.id)}">
    <input class="library-summary" type="text" value="${escape(item.summary)}" data-library-summary="${escape(item.id)}" aria-label="记忆摘要"/>
    <textarea class="library-content" data-library-content="${escape(item.id)}" aria-label="记忆正文" rows="4">${escape(item.content || "")}</textarea>
    <div class="memory-meta">
      <select data-library-type="${escape(item.id)}" aria-label="类型">${options(MEMORY_TYPES, item.type)}</select>
      <select data-library-sensitivity="${escape(item.id)}" aria-label="敏感度">${options(MEMORY_SENSITIVITIES, item.sensitivity)}</select>
      <select class="memory-status" data-library-status="${escape(item.id)}" aria-label="状态"><option value="active" ${item.status === "active" ? "selected" : ""}>使用中</option><option value="archived" ${item.status === "archived" ? "selected" : ""}>已归档</option></select>
      <span>${escape(item.confidence)} 置信度</span>
      <span>召回 ${item.accessCount || 0} 次</span>
      ${item.sourceRunId && item.sourceRunId !== "owner" ? `<button class="memory-source" type="button" data-open-memory-source="${escape(item.sourceRunId)}">查看来源</button>` : `<span>由你写入</span>`}
      <span class="library-file">${escape(item.id)}.md</span>
      <button class="memory-save" type="button" data-save-library="${escape(item.id)}">保存</button>
    </div>
  </article>`).join("") : `<div class="memory-empty">记忆库还是空的。写下一条你希望分身长期记住的偏好、边界或事实——它会成为一个你随时可以打开和修改的 .md 文件。</div>`;
  $("library-list").innerHTML = conflicts + cards;
  if (library.syncError) announce(`磁盘上的记忆文件读取失败：${library.syncError}`, true);
}

async function saveLibraryMemory(id) {
  const pick = (attribute) => document.querySelector(`[data-library-${attribute}="${CSS.escape(id)}"]`);
  const body = {
    summary: pick("summary").value,
    content: pick("content").value,
    type: pick("type").value,
    sensitivity: pick("sensitivity").value,
    status: pick("status").value,
  };
  const button = document.querySelector(`[data-save-library="${CSS.escape(id)}"]`);
  if (button) button.disabled = true;
  try {
    await api(`/api/memory/governed/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    state.signatures.library = null;
    await refresh();
    announce("记忆已保存，对应的 .md 文件也已更新。");
  } catch (error) { announce(error.message, true); } finally { if (button) button.disabled = false; }
}
async function keepMemoryFile(id) { if (!(await confirmDialog(t("memory-keep-confirm"), t("memory-keep-file")))) return; try { await api(`/api/memory/governed/conflicts/${encodeURIComponent(id)}/keep-file`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmDiscardPendingChange: true }) }); await refresh(); announce(t("memory-conflict-resolved")); } catch (error) { announce(error.message, true); } }

async function createLibraryMemory() {
  const summary = $("library-new-summary").value.trim();
  if (summary.length < 3) { announce("请写下一条至少三个字的摘要。", true); return; }
  const button = $("library-create");
  button.disabled = true;
  try {
    await api("/api/memory/governed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ summary, content: $("library-new-content").value.trim(), type: $("library-new-type").value, sensitivity: $("library-new-sensitivity").value }) });
    $("library-new-summary").value = "";
    $("library-new-content").value = "";
    state.signatures.library = null;
    await refresh();
    announce("已写入记忆库。");
  } catch (error) { announce(error.message, true); } finally { button.disabled = false; }
}

function renderContext(context) {
  state.context = context;
  const signature = JSON.stringify(context);
  if (state.signatures.context === signature) return;
  state.signatures.context = signature;
  const compactions = context.compactions || [];
  // entriesOutOfContext is the headline: it is the part of the conversation the
  // model can no longer see but that search_history can still reach.
  $("context-overview").innerHTML = `<article class="memory-stat"><b>${context.messageEntries || 0}</b><span>历史消息</span></article><article class="memory-stat"><b>${compactions.length}</b><span>压缩次数</span></article><article class="memory-stat"><b>${context.entriesOutOfContext || 0}</b><span>已压缩出上下文</span></article><article class="memory-stat file-stat"><b>jsonl</b><span>${escape(context.directory || "-")}</span></article>`;
  $("context-compactions").innerHTML = compactions.length ? `<h4>压缩记录</h4><p class="candidates-hint">每一次压缩都写下了一段摘要，被摘要掉的原文仍在磁盘上，可以被搜索回来。</p>${compactions.map((item) => `<article class="memory-card"><div class="memory-meta"><span>${escape(String(item.at || "").slice(0, 16).replace("T", " "))}</span><span>压缩前约 ${item.tokensBefore || 0} tokens</span></div><p class="context-summary">${escape(item.summaryPreview || "（没有摘要文本）")}</p></article>`).join("")}` : `<div class="memory-empty">还没有发生过压缩。对话仍然完整地在模型上下文里。</div>`;
  const conversations = context.conversations || [];
  $("context-conversations").innerHTML = conversations.length ? `<h4>对话（${conversations.length}）</h4>${conversations.map((item) => `<article class="memory-card"><div class="memory-meta">${item.active ? `<span class="context-active">当前对话</span>` : ""}<span>${item.messages} 条消息</span><span>${time(item.updatedAt)}</span></div><p class="context-summary">${escape(item.preview || "（没有预览）")}</p></article>`).join("")}` : "";
}

function renderContextSearch(excerpts) {
  $("context-search-results").innerHTML = excerpts.length ? excerpts.map((item) => `<article class="memory-match context-match"><div><b>${escape(item.speaker)} · ${escape(String(item.at || "").slice(0, 16).replace("T", " "))}${item.outOfContext ? " · 已压缩出上下文" : ""}</b><small>${escape(item.excerpt)}</small></div><span>${Math.round(item.score * 100)}%</span></article>`).join("") : `<div class="memory-empty">完整历史里没有匹配的内容。</div>`;
}

async function searchContextHistory(query) { try { renderContextSearch((await api(`/api/context/search?q=${encodeURIComponent(query)}`)).excerpts || []); } catch (error) { announce(error.message, true); } }
function welcomeMarkup() {
  return `<div class="welcome">
    <div class="welcome-copy">
      <span class="welcome-eyebrow">${escape(t("new-session"))}</span>
      <h2>今天想推进什么？</h2>
      <p>直接描述目标，或贴一段上下文。我会先拆解、准备和验证；会影响外部世界的动作会先停下来问你。</p>
      <p class="welcome-routing">${escape(t("welcome-routing"))}</p>
    </div>
  </div>`;
}
/** Inline Markdown inside a table cell: the same escape-first path as a message. 表格单元格内的行内 Markdown：与消息相同的先转义路径。 */
function mdInline(value) {
  return escape(value)
    .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
    .replace(/`([^`\n]+)`/g, '<code class="md-inline">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
}
/**
 * Splits a GFM table row on unescaped pipes. A leading or trailing pipe is
 * optional and does not create an empty cell; `\|` is a literal pipe.
 * 按未转义的竖线切分 GFM 表格行。首尾竖线可选，且不会产生空单元格；`\|` 是字面竖线。
 */
function splitTableRow(line) {
  const cells = [];
  let current = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\\" && line[index + 1] === "|") { current += "|"; index += 1; continue; }
    if (character === "|") { cells.push(current); current = ""; continue; }
    current += character;
  }
  cells.push(current);
  if (line.trimStart().startsWith("|")) cells.shift();
  if (line.trimEnd().endsWith("|") && !line.trimEnd().endsWith("\\|") && cells.length > 0) cells.pop();
  return cells.map((cell) => cell.trim());
}
/** GFM delimiter row → per-column alignment, or undefined when the row is not one. 分隔行 → 每列对齐，或 undefined 表示不是分隔行。 */
function tableAlignments(line) {
  if (!line.includes("|")) return undefined;
  const cells = splitTableRow(line);
  if (cells.length === 0) return undefined;
  const alignments = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return undefined;
    alignments.push(cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : undefined);
  }
  return alignments;
}
/**
 * Lifts GFM table blocks out of the source before the inline pass. A table is a
 * header row, a delimiter row with the same cell count, and body rows up to the
 * next blank line. The caller restores the placeholders after escaping.
 * 在行内渲染之前把 GFM 表格块取出：表头行、单元格数相同的分隔行，以及直到下一个空行为止的
 * 数据行。调用方在转义之后恢复占位符。
 */
function extractMarkdownTables(source) {
  const lines = source.split("\n");
  const tables = [];
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index] ?? "";
    const delimiter = lines[index + 1] ?? "";
    const alignments = header.includes("|") ? tableAlignments(delimiter) : undefined;
    if (alignments !== undefined) {
      const headerCells = splitTableRow(header);
      if (headerCells.length > 0 && headerCells.length === alignments.length) {
        const rows = [];
        let cursor = index + 2;
        while (cursor < lines.length && (lines[cursor] ?? "").trim() !== "" && (lines[cursor] ?? "").includes("|")) {
          rows.push(splitTableRow(lines[cursor] ?? ""));
          cursor += 1;
        }
        tables.push({ alignments, header: headerCells, rows });
        kept.push(`\u0000TABLE${tables.length - 1}\u0000`);
        index = cursor - 1;
        continue;
      }
    }
    kept.push(lines[index] ?? "");
  }
  return { source: kept.join("\n"), tables };
}
/** The plain text of a cell for CSV: markup is flattened, line breaks survive. 供 CSV 使用的单元格纯文本：标记压平，换行保留。 */
function tableCellText(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .trim();
}
function csvCell(value) {
  const text = tableCellText(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function markdownTableMarkup(table) {
  const alignment = (index) => table.alignments[index] ? ` md-table-cell--${table.alignments[index]}` : "";
  const head = table.header.map((cell, index) => `<th class="md-table-cell${alignment(index)}">${mdInline(cell)}</th>`).join("");
  const body = table.rows.map((row) => `<tr>${table.header.map((_, index) => `<td class="md-table-cell${alignment(index)}">${mdInline(row[index] ?? "")}</td>`).join("")}</tr>`).join("");
  const csv = [table.header, ...table.rows].map((row) => table.header.map((_, index) => csvCell(row[index] ?? "")).join(",")).join("\n");
  // The CSV rides on the button so the click handler needs no table registry:
  // escaped into an attribute, it survives every re-render of the message.
  // Newlines become character references because the message pass turns literal
  // newlines into <br> after this markup is restored; the DOM decodes them back.
  // CSV 随按钮保存，点击处理无需表格注册表：转义进属性后，它能在消息的每次重渲染中存活。
  // 换行变成字符引用，因为在这段标记恢复之后，消息渲染会把字面换行变成 <br>；DOM 会解码回来。
  const csvAttribute = escape(csv).replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");
  return `<div class="md-table-wrap"><div class="md-table-tools"><button class="md-table-export" type="button" data-export-table data-export-csv="${csvAttribute}" title="导出 CSV（Excel 可直接打开）" aria-label="导出这张表为 CSV">导出 CSV</button></div><div class="md-table-scroll"><table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></div>`;
}
function richText(value) {
  const blocks = [];
  const source = String(value ?? "").replace(/\r\n?/g, "\n")
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
      const index = blocks.push(`<div class="md-code-wrap"><button class="md-copy" type="button" data-copy-code>复制</button><pre class="md-code"><code>${escape(code.replace(/^\n+|\n+$/g, ""))}</code></pre></div>`) - 1;
      return `\n\u0000BLOCK${index}\u0000\n`;
    });
  // Tables leave the source before escaping; their generated markup is restored
  // after the inline pass, so it is not escaped with the message text.
  // 表格在转义之前离开源文本；生成的标记在行内渲染之后恢复，因此不会随消息正文一起被转义。
  const extracted = extractMarkdownTables(source);
  return escape(extracted.source)
    .replace(/`([^`\n]+)`/g, '<code class="md-inline">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/^#{1,4}\s+(.+)$/gm, '<div class="md-heading">$1</div>')
    .replace(/^\s*[-*]\s+(.+)$/gm, '<div class="md-list-line"><span aria-hidden="true">•</span><span>$1</span></div>')
    .replace(/^\s*(\d+)[.)]\s+(.+)$/gm, '<div class="md-list-line md-list-line--ordered"><span>$1.</span><span>$2</span></div>')
    .replace(/\u0000TABLE(\d+)\u0000/g, (match, index) => markdownTableMarkup(extracted.tables[Number(index)] ?? { alignments: [], header: [], rows: [] }))
    .replace(/\n/g, "<br>")
    // A block element already starts a new line, so a <br> next to it only adds an
    // empty line: list items used to render double-spaced with the marker far from
    // its text. 块级元素本身就会换行，紧邻的 <br> 只会多出一整行——列表项因此被拉开双倍行距，
    // 圆点离正文很远。
    .replace(/<br>(?=<div class="md-(?:heading|list-line|table-wrap))/g, "")
    .replace(/(<\/div>)<br>/g, "$1")
    .replace(/\u0000BLOCK(\d+)\u0000/g, (match, index) => blocks[Number(index)] ?? "");
}
function messageMarkup(message) {
  const clone = message.role === "clone";
  const text = String(message.text ?? "").trim();
  if (!text) return "";
  const tone = message.tone ? ` ${message.tone}` : "";
  const collapsible = clone && text.length > 480;
  // The owner pastes task briefs, not prose: headings, lists, inline code and
  // bold must render instead of arriving as literal markdown. richText escapes
  // its input first, so a message cannot inject markup.
  // 所有者粘贴的是任务说明而不是散文：标题、列表、行内代码与粗体应当渲染，而不是以字面
  // Markdown 出现。richText 先转义输入，因此消息不能注入标记。
  const body = richText(text);
  // The conversation reads like Codex: the owner is a compact right-aligned
  // instruction, while the agent's work stays in the main reading column.
  // 对话按 Codex 的方式排版：所有者指令靠右且紧凑，Agent 工作留在主阅读栏。
  const technical = message.tone === "warning"
    && !text.includes("下一步：")
    && /Unrestricted host execution|permission_denied|no enforced sandbox/i.test(text);
  const displayed = technical
    ? "这次任务没有执行：本机 Worker 默认禁止不受限访问。请到「设置 → Agent」为绑定的 Worker 明确开启运行权限，或改用一个已允许的 Worker。"
    : text;
  const displayedBody = clone && technical ? escape(displayed) : body;
  const needsAgentSettings = clone && message.tone === "warning"
    && /设置\s*→\s*Agent|Worker|Provider|permission_denied|no enforced sandbox|Unrestricted host execution/i.test(text);
  const actions = needsAgentSettings
    ? `<div class="message-actions"><button class="secondary" type="button" data-open-agent-settings>打开 Agent 设置</button></div>`
    : "";
  return `<article class="message ${clone ? "clone" : "person"}"><div class="message-heading"><b>${clone ? "clone-ai" : "你"}</b><time>${time(message.occurredAt)}</time></div><div class="message-body">${clone ? `<div class="clone-card${tone}"><div class="clone-text${collapsible ? " collapsible collapsed" : ""}">${displayedBody}</div>${collapsible ? `<button class="clone-expand" type="button" data-expand>展开全部</button>` : ""}${actions}</div>` : `<div class="message-copy">${body}</div>`}</div></article>`;
}
/**
 * A conversation's turn log shows the result and its grounds, not the process.
 *
 * Every new task dispatches its work as Kernel runs, and the sidebar already
 * lists those runs under the conversation. What the owner reads between a
 * request and its answer is the product: the reply, the runs the turn spawned,
 * and one line naming how much the turn consulted, with a link into the audit.
 * The context the model was given and every tool call's input live in
 * 设置 → 审计与轨迹 → 主 Agent 回合, where they are searchable.
 *
 * 对话的回合日志显示结果与依据，而不是过程。
 *
 * 每个新任务都把工作派发成 Kernel Run，侧栏已经把这些 Run 列在对话之下。所有者在请求与
 * 回答之间读到的是产物：回复、本回合派生的 Run，以及一行说明查了多少工具调用并提供审计
 * 入口。模型拿到的上下文与每次工具调用的输入在 设置 → 审计与轨迹 → 主 Agent 回合，
 * 那里可以搜索。
 */
const LOG_STATUS = {
  completed: ["完成", "ok"], failed: ["失败", "bad"], interrupted: ["中断", "warn"], started: ["进行中", "info"], info: ["历史", "mute"],
  cancelled: ["已取消", "mute"], waiting_approval: ["等待确认", "warn"], waiting_review: ["等待复核", "warn"],
  queued: ["排队中", "info"], planning: ["规划中", "info"], running: ["运行中", "info"], verifying: ["验证中", "info"], created: ["已创建", "mute"],
};
function logStatus(status) { const [label, tone] = LOG_STATUS[status] || [status || "未知", "mute"]; return { label, tone }; }
function logDuration(ms) { return ms === undefined ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`; }
function logBasisMarkup(entry, conversationId) {
  // The grounds a conclusion stands on, kept to one line: how much this turn
  // consulted and where its record is. The model, the prompt snapshot and every
  // call's input stay in the audit.
  // 结论所依据的东西压缩成一行：本回合查了多少、记录在哪里。模型、提示词快照与每次调用的
  // 输入留在审计页。
  const tools = entry.toolCalls || [];
  const runs = entry.spawnedRuns || [];
  const failed = tools.filter((call) => call.isError).length;
  const facts = [];
  if (tools.length > 0) facts.push(`工具调用 ${tools.length} 次${failed > 0 ? `（${failed} 次失败）` : ""}`);
  if (runs.length > 0) facts.push(`派生任务 ${runs.length} 个`);
  if (facts.length === 0) {
    if (!entry.journaled) facts.push("没有 Journal 记录，过程无法还原。");
    else if (entry.status === "started") facts.push("仍在运行；还没有工具调用记录。");
    else if (entry.status === "failed" || entry.status === "interrupted") facts.push("本轮在调用工具前就结束了。");
    else facts.push("本轮直接回答，没有调用工具或派发任务。");
  }
  // The audit is a projection of the journal: without a journal record there is
  // no page to open, so the control is absent rather than a dead end.
  // 审计是 Journal 的投影：没有 Journal 记录就没有可打开的页面，因此控件不出现，而不是
  // 一个失效的死角。
  // The locator is the turn id, not the request: a request can be 20,000
  // characters (a GET query of that size is rejected with 431) and the journal
  // stores it redacted, so the raw text is not a reliable key. The conversation
  // id keeps a reused turn id from matching another task.
  // 定位键是回合 id，而不是请求：请求可达 20,000 字（这个长度的 GET query 会被 431 拒绝），
  // 且 Journal 存的是脱敏后的文本，原文不是可靠的键。带上对话 id，复用的回合 id 就不会
  // 命中另一个任务。
  const preview = plainPreview(entry.input || "").slice(0, 24);
  const audit = entry.journaled
    ? `<button class="log-basis-open" type="button" data-open-turn-audit="${escape(entry.id)}" data-open-turn-conversation="${escape(conversationId || "")}" aria-label="查看审计：${escape(preview || "本回合")} · ${escape(time(entry.startedAt))}">查看审计 ›</button>`
    : "";
  return `<div class="log-basis"><b>依据</b><span>${escape(facts.join(" · "))}</span>${audit}</div>`;
}
function logResultMarkup(entry) {
  if (entry.error) {
    // The raw ledger error is for diagnosis; the owner-facing summary and next
    // step are what the conversation used to show. Keep both, the readable one
    // first.
    // 原始台账错误用于诊断；所有者可读的摘要与下一步才是对话过去显示的内容。两者都保留，
    // 可读的在前。
    const needsAgentSettings = /Unrestricted host execution|permission_denied|no enforced sandbox|设置\s*→\s*Agent|Worker|Provider/i.test(entry.error);
    return `<div class="log-error"><b>错误</b><p>${escape(entry.errorSummary || entry.error)}</p>${entry.errorGuidance ? `<p class="log-error-guidance">下一步：${escape(entry.errorGuidance)}</p>` : ""}${needsAgentSettings ? `<div class="message-actions"><button class="secondary" type="button" data-open-agent-settings>打开 Agent 设置</button></div>` : ""}<details class="log-detail"><summary>原始错误</summary><pre>${escape(entry.error)}</pre></details></div>`;
  }
  if (entry.reply && entry.reply.trim().length > 0) return `<div class="log-reply">${richText(entry.reply)}</div>`;
  if (entry.status === "started") return `<span class="log-fact log-fact--muted">仍在本地运行时中推进。</span>`;
  if (entry.kind === "history") return `<span class="log-fact log-fact--muted">旧记录没有保存回复。</span>`;
  return `<span class="log-fact log-fact--muted">本轮没有返回文字。</span>`;
}
function logQueryMarkup(input) {
  const text = String(input || "").trim();
  if (text.length === 0) return "";
  // The owner's request is a right-aligned bubble; the twin's answer is the
  // left-hand section below it. Mixing both into one bordered block made the
  // two voices indistinguishable once a reply grew long.
  // 所有者的请求是靠右的气泡，分身的回答是它下面左侧的章节。把两者放进同一个带边框的块里，
  // 一旦回复变长就分不清谁在说话。
  return `<article class="turn-query" aria-label="你的请求"><div class="turn-query-bubble"><span class="turn-query-who">你</span><div class="turn-query-text">${richText(text)}</div></div></article>`;
}
function logEntryMarkup(entry, conversationId) {
  const status = logStatus(entry.status);
  const duration = logDuration(entry.durationMs);
  const history = entry.kind === "history";
  // The answer names its author. The request is already above it as a bubble,
  // so the head carries only the author, state and time. Everything sits on the
  // left as one byline: a status stranded at the right edge can read as the
  // request's completion, and it belongs beside the author it describes.
  // 回答标明作者。请求已作为气泡在其上方，因此头部只保留作者、状态与时间。它们都在左侧
  // 排成一条署名：孤零零挂在右端的状态会被读成请求的完成态，而状态属于它描述的作者。
  const meta = `<span class="log-entry-meta"><span class="log-badge log-badge--${status.tone}">${escape(status.label)}</span><small>${time(entry.startedAt)}${duration ? ` · ${escape(duration)}` : ""}</small></span>`;
  const head = `<div class="log-entry-head"><span class="log-entry-kicker">${history ? "历史记录" : "clone-ai"}</span>${meta}</div>`;
  // Legacy history entries never entered the journal, so they are honest about
  // it: the reply is still the product, and there is no process to link to.
  // 旧历史条目从未进入 Journal，因此如实说明：回复仍是产物，但没有可链接的过程。
  const body = history
    ? `<div class="log-step"><span class="log-step-label">结果</span><div class="log-step-body">${logResultMarkup(entry)}<div class="log-basis"><b>依据</b><span>旧记录没有保存过程。</span></div></div></div>`
    : `<div class="log-step"><span class="log-step-label">结果</span><div class="log-step-body">${logResultMarkup(entry)}${logBasisMarkup(entry, conversationId)}</div></div>`;
  return `${logQueryMarkup(entry.input)}<article class="log-entry" data-log-kind="${escape(entry.kind)}" data-log-status="${escape(entry.status)}">${head}<div class="log-entry-body">${body}</div></article>`;
}
function workLogMarkup(message) {
  // A cancelled update is not a success: the badge follows the run's own
  // status, not the presence or absence of a warning tone.
  // 已取消的更新不是成功：标签跟随 Run 自己的状态，而不是有没有告警色调。
  const rawStatus = message.workStatus || (message.tone === "warning" ? "waiting_review" : "completed");
  const status = logStatus(rawStatus);
  // A work update is a notice about a task, not a turn: it keeps the same
  // status vocabulary but sits as an indented margin note beside the timeline.
  // 任务更新是关于任务的通知，不是回合：它沿用同一套状态词汇，但以缩进页边注贴时间线上。
  return `<article class="log-entry log-entry--work" data-log-kind="work" data-log-status="${escape(rawStatus)}"><div class="log-entry-head"><b class="log-query">任务更新</b><span class="log-badge log-badge--${status.tone}">${escape(status.label)}</span><small>${time(message.occurredAt)}</small></div><div class="log-reply">${richText(message.text)}</div></article>`;
}
function turnLogMarkup(session) {
  const entries = (session.turns || []).map((entry) => ({ at: entry.startedAt, markup: logEntryMarkup(entry, session.id) }));
  for (const message of session.messages || []) {
    if (!String(message.id || "").startsWith("work-")) continue;
    entries.push({ at: message.occurredAt, markup: workLogMarkup(message) });
  }
  if (entries.length === 0) return "";
  entries.sort((left, right) => String(left.at).localeCompare(String(right.at)));
  const omitted = Number(session.turnsOmitted) > 0
    ? `<p class="log-omitted">更早的 ${escape(session.turnsOmitted)} 个回合未在此显示；可在 设置 → 审计与轨迹 → 回合 搜索。</p>`
    : "";
  return `<section class="turn-log" aria-label="Main Agent 运行日志">${omitted}${entries.map((entry) => entry.markup).join("")}</section>`;
}
function sessionHasContent(session) {
  if (!session) return false;
  if (session.kind === "conversation") return (session.turns || []).length > 0 || (session.messages || []).some((message) => String(message.id || "").startsWith("work-"));
  return session.messages.length > 0;
}
function displayAgentTitle(agent) { return agent.title; }function displayAgentDetail(agent) { const provider = agent.providerId ? `${providerLabel(agent.providerId)} · ` : ""; return provider + (agent.status === "completed" ? "已提交可验证证据" : (agent.summary || "正在按任务边界推进")); }
function disclosureOpen(session, name, fallback = false) { return state.openDisclosures.get(session.id)?.get(name) ?? fallback; }
function planMarkup(session) { if (!session.plan) return ""; const fallback = session.status === "waiting_approval" || !["completed", "failed", "cancelled"].includes(session.status); const open = disclosureOpen(session, "plan", fallback) ? " open" : ""; return `<details class="activity-card plan-card" data-disclosure="plan"${open}><summary class="activity-summary">${icon("spark")}<b>执行计划</b><span>${session.plan.steps.length} 步</span></summary><p class="plan-summary">${escape(session.plan.summary)}</p><div class="plan-steps">${session.plan.steps.map((step, index) => `<div class="plan-step"><span class="plan-step-index">${index + 1}</span><b>${escape(step.title)}</b>${step.agentId ? `<em class="plan-step-worker">由 ${escape(step.agentId)} 执行</em>` : ""}<span>${step.delegated ? "委派执行" : step.risk === "read_only" ? "直接处理" : step.risk === "reversible_write" ? "本地写入" : step.risk === "external_side_effect" ? "外部动作" : step.risk === "irreversible" ? "不可逆" : escape(step.risk)}</span></div>`).join("")}</div></details>`; }
/** A fact-only next step derived from the recorded failure; it never invents a cause. 由已记录失败推导的、只含事实的下一步；绝不编造原因。 */
function agentFixHint(agent) {
  const summary = String(agent.summary || "").toLowerCase();
  if (agent.status === "failed") {
    if (summary.includes("artifact contract")) return "这一步要求交付文件，但 Worker 只给出了观察证据。把请求改成只读回答，或在请求里明确要写的文件与路径。";
    if (summary.includes("interrupted") || summary.includes("replay-safety")) return "这次执行被中断，且没有安全重放保证。先检查工作区是否已有部分写入，再决定是否重试。";
    return "Worker 没有完成这一步。查看下面的证据或在任务记录里看失败原因，补上缺失的输入或缩小范围后重试。";
  }
  if (agent.status === "cancelled") return "这一步被取消，没有产生结果；需要时重新发起。";
  return "";
}
function agentsMarkup(session) {
  if (!session.subagents.length) return "";
  const completed = session.subagents.filter((agent) => agent.status === "completed" && !agent.review).length;
  const review = session.subagents.filter((agent) => agent.review).length;
  const failed = session.subagents.filter((agent) => agent.status === "failed" && !agent.review).length;
  const focusId = state.agentFocus?.runId === session.id ? state.agentFocus.agentId : undefined;
  const fallback = session.status === "waiting_approval" || !["completed", "failed", "cancelled"].includes(session.status);
  const open = disclosureOpen(session, "agents", fallback) || focusId !== undefined ? " open" : "";
  // A subagent row explains itself in place: its status, its recorded summary,
  // its evidence and a deterministic "what to change" hint. A work order whose
  // artifact contract needs the owner carries the decision here, where the
  // failure is visible; the full execution trace stays behind an explicit,
  // clearly labelled audit link.
  // 子 Agent 行原地解释自己：状态、记录的摘要、证据，以及确定性的"要修改什么"提示。产物
  // 合同需要所有者的工作单把这个决定带到这里——失败可见的地方；完整执行轨迹留在显式且
  // 标注清楚的审计链接后面。
  const rows = session.subagents.map((agent) => {
    const status = statusMeta(agent.status);
    const focused = agent.id === focusId ? ' data-agent-focus="true"' : "";
    const body = `<span class="status-dot ${status.dot}"></span><span class="agent-row-text"><strong>${escape(displayAgentTitle(agent))}</strong><small>${escape(displayAgentDetail(agent))}</small></span><span class="agent-status">${escape(agent.review ? "需要复核" : status.label)}</span>`;
    const hint = agent.review ? "" : agentFixHint(agent);
    const evidence = (agent.evidence || []).map((item) => `<li><b>${escape(item.kind)}</b> ${escape(item.summary)}${item.locator ? ` · <code>${escape(item.locator)}</code>` : ""}</li>`).join("");
    const reviewBlock = agent.review ? `<div class="agent-review">
      <b>需要你确认</b>
      <p>${escape(agent.review.summary)}</p>
      ${(agent.review.unverifiedCriteria || []).length ? `<ul class="agent-review-criteria">${agent.review.unverifiedCriteria.map((item) => `<li>${escape(item)}</li>`).join("")}</ul>` : ""}
      <p class="agent-review-note">接受会保留 Worker 的回答并结束这次运行；拒绝会判为失败。</p>
      <div class="approval-actions"><button class="approve" type="button" data-review="${escape(agent.review.runId)}" data-review-decision="accept">继续（接受观察证据）</button><button class="secondary" type="button" data-review="${escape(agent.review.runId)}" data-review-decision="reject">判为失败</button></div>
    </div>` : "";
    const openable = typeof agent.runId === "string" && agent.runId.length > 0 && agent.runId !== session.id;
    const panel = `<div class="agent-detail">
      ${agent.summary ? `<p class="agent-detail-summary">${escape(agent.summary)}</p>` : ""}
      ${reviewBlock}
      ${hint ? `<p class="agent-detail-hint"><b>要修改什么</b> ${escape(hint)}</p>` : ""}
      ${evidence ? `<ul class="agent-detail-evidence">${evidence}</ul>` : ""}
      ${openable ? `<button class="agent-run-link" type="button" data-open-agent-run="${escape(agent.runId)}" data-agent-id="${escape(agent.id)}" title="审计页展示这次运行的全部工具调用与证据，只读，不会重跑">打开审计查看完整轨迹（只读，不会重跑）</button>` : ""}
    </div>`;
    return `<details class="agent-row-details" data-agent-id="${escape(agent.id)}"${focused}${agent.id === focusId ? " open" : ""}><summary class="agent-row">${body}</summary>${panel}</details>`;
  }).join("");
  return `<details class="activity-card" data-disclosure="agents"${open}><summary class="activity-summary">${icon("spark")}<b>Agent 协作</b><span>${completed}/${session.subagents.length} 已完成${review === 0 ? "" : ` · ${review} 需要复核`}${failed === 0 ? "" : ` · ${failed} 需要处理`}</span></summary><div class="agent-list">${rows}</div></details>`;
}
function approvalMarkup(session) {
  const approvals = session.approvals || [];
  if (!approvals.length) return "";
  // The decision belongs to the task record that owns the run. Stating that the
  // task will not proceed without an answer is the point of the card.
  // 决定属于拥有该 Run 的任务记录。明确说出"不回答就不会继续"，才是这张卡片的意义。
  const heading = approvals.length === 1 ? "需要你确认后才能继续" : `${approvals.length} 项需要你确认`;
  return `<section class="approval-card approval-card-action"><div class="approval-kicker">需要你的决定 · 不会自动继续</div><h2>${escape(heading)}</h2>${approvals.map((approval) => {
    const step = typeof approval.title === "string" && approval.title.length > 0 && approval.title !== session.title
      ? `<p class="approval-step">步骤：${escape(approval.title)}</p>`
      : "";
    // The owner cannot judge a scope they cannot see. The Kernel's refusal and
    // the AI judge's reason are part of the decision, not the audit page.
    // 所有者无法判断看不见的 Scope。Kernel 的拒绝与 AI 裁判的理由是决定的一部分，
    // 不应只藏在审计页。
    const scopes = (approval.scopes || []).map((scope) =>
      `<li><code>${escape(scope.domain)}:${escape(scope.access)}</code> ${escape(scope.resource)}</li>`).join("");
    const reason = typeof approval.reason === "string" && approval.reason.length > 0
      ? `<p class="approval-reason">${escape(approval.reason)}</p>`
      : "";
    return `<div class="approval-item"><b>${escape(session.title)}</b>${step}<p>${escape(approval.description || "下一步需要你的确认后才能继续。")}</p>${reason}${scopes.length > 0 ? `<ul class="approval-scopes">${scopes}</ul>` : ""}<div class="approval-actions"><button class="approve" type="button" data-approve="${escape(approval.runId)}">确认并继续</button><button class="secondary" type="button" data-reject="${escape(approval.runId)}">拒绝</button></div></div>`;
  }).join("")}</section>`;
}
function reviewMarkup(session) {
  // Reviews are decisions too, and they are decided on the same task record:
  // its criteria, its worker's answer and its own accept/reject pair.
  // 复核也是决定，并在同一个任务记录上完成：它的标准、它的 Worker 回答与它自己的接受/拒绝按钮。
  const reviews = session.reviews || [];
  if (!reviews.length) {
    if (session.status !== "waiting_review") return "";
    // A waiting review whose verification record is missing still needs a
    // decision; the buttons work by run id.
    // 等待复核但缺少核验记录时仍需要决定；按钮按 Run id 生效。
    return `<section class="approval-card approval-card-action"><div class="approval-kicker">等待你的复核</div><h2>${escape(session.title || "结果等待复核")}</h2><p>这个任务已经结束，但还没有可显示的核验记录。</p><div class="approval-actions"><button class="approve" type="button" data-review="${escape(session.id)}" data-review-decision="accept">接受结果</button><button class="secondary" type="button" data-review="${escape(session.id)}" data-review-decision="reject">拒绝</button></div></section>`;
  }
  const heading = reviews.length === 1 ? "需要你复核结果" : `${reviews.length} 项结果等待复核`;
  return `<section class="approval-card approval-card-action"><div class="approval-kicker">等待你的复核 · 系统不会自行通过</div><h2>${escape(heading)}</h2>${reviews.map((review) => {
    const criteria = (review.verification.unverifiedCriteria || []).map((criterion) => `<li>${escape(criterion)}</li>`).join("");
    const summary = criteria.length === 0 && review.verification.summary ? `<p>${escape(review.verification.summary)}</p>` : "";
    // The decision is about this answer. Without it the card showed only the
    // criteria and the evidence count, and the owner had nothing to review.
    // 决定正是针对这个回答。没有它，卡片只有验收标准与证据计数，所有者没有可复核的内容。
    const result = typeof review.result === "string" && review.result.trim().length > 0
      ? `<div class="review-result"><b>Worker 的结论</b><div>${richText(review.result)}</div></div>`
      : "";
    return `<div class="approval-item"><b>${escape(review.title)}</b>${result}${summary}${criteria ? `<ul>${criteria}</ul>` : ""}<div class="approval-actions"><button class="approve" type="button" data-review="${escape(review.runId)}" data-review-decision="accept">接受结果</button><button class="secondary" type="button" data-review="${escape(review.runId)}" data-review-decision="reject">拒绝</button></div></div>`;
  }).join("")}</section>`;
}

/**
 * The record of a finished run: what the system concluded, what the owner
 * decided, and the criteria behind both. It stays on the task record after the
 * decision, which is where the owner goes to ask what happened.
 * 已结束 Run 的记录：系统得出什么、所有者决定了什么，以及两者背后的标准。决定之后它
 * 仍留在任务记录里——所有者正是回到这里查"发生了什么"。
 */
function verificationMarkup(session) {
  const verification = session.verification;
  if (!verification) return "";
  // The owner's decision is what the task record is about, so it is the
  // verdict: the pill shows their choice once they made one, and the system's
  // conclusion moves into the detail line instead of contradicting it.
  // 所有者作出的决定才是任务记录的重点，因此它就是结论：所有者做出决定后，标签显示他们的
  // 选择，而系统结论移到细节行里，不与它矛盾。
  const owner = verification.reviewedBy === "owner";
  const decided = owner ? (verification.passed ? "已接受结果" : "已驳回结果") : undefined;
  const tone = owner ? (verification.passed ? "ok" : "bad") : verification.passed ? "ok" : verification.needsReview ? "warn" : "bad";
  const verdict = decided ?? (verification.passed ? "通过" : verification.needsReview ? "需要你的复核" : "未通过");
  const ownerLine = !owner && verification.needsReview
    ? `<span class="verification-owner is-pending">等待你的决定</span>`
    : "";
  const systemLine = verification.needsReview && owner
    ? `<span class="verification-system">系统结论：自动检查通过，${(verification.unverifiedCriteria || []).length} 项标准需人工判断</span>`
    : "";
  // Records written before the summary stopped repeating the criteria still
  // carry the old long sentence; show the count instead of the wall of text.
  // 在摘要不再重复标准之前写下的记录仍带着旧的长句；显示计数，而不是一堵文字墙。
  const rawSummary = String(verification.summary ?? "");
  const legacySummary = rawSummary.startsWith("Checks passed, but these criteria need owner review")
    ? `自动检查通过；${(verification.unverifiedCriteria || []).length} 项标准需人工判断。`
    : rawSummary;
  const summary = legacySummary;
  // Title and criterion are split so a repeated step title becomes a group
  // heading while the numbers still come from the stored array.
  // 标题与标准拆开显示：重复的步骤标题成为分组标题，编号仍来自存储的数组。
  const criteria = (verification.unverifiedCriteria || []).length
    ? `<ol class="verification-criteria">${verification.unverifiedCriteria.map((criterion) => {
        const separator = criterion.indexOf(": ");
        const title = separator > 0 ? criterion.slice(0, separator) : "";
        const text = separator > 0 ? criterion.slice(separator + 2) : criterion;
        return `<li>${title ? `<b>${escape(title)}</b><span>${escape(text)}</span>` : `<span>${escape(text)}</span>`}</li>`;
      }).join("")}</ol>`
    : "";
  return `<section class="activity-card verification-card" data-verification>
    <div class="verification-head"><b>核验结果</b><span class="status-pill ${tone}">${escape(verdict)}</span>${ownerLine}</div>
    ${summary ? `<p class="verification-summary">${escape(summary)}</p>` : ""}
    ${systemLine}
    ${criteria}
    <p class="verification-foot">检查了 ${verification.checkedEvidenceIds?.length ?? 0} 条证据${verification.createdAt ? ` · ${time(verification.createdAt)}` : ""}</p>
  </section>`;
}

/**
 * What the run produced: artifact rows first (the deliverable), then the
 * observations behind them. A count alone told the owner "9 条证据" and nothing
 * about what they were.
 * Run 产出了什么：先是产物行（交付物），再是支撑它们的观察记录。只给计数只会告诉所有者
 * "9 条证据"，却说不出它们是什么。
 */
function evidenceMarkup(session) {
  const evidence = Array.isArray(session.evidence) ? session.evidence : [];
  const count = session.evidenceCount ?? evidence.length;
  if (!count) return "";
  if (!evidence.length) return `<div class="evidence">${icon("check")}已记录 ${count} 条可验证证据</div>`;
  const artifacts = evidence.filter((item) => item.kind === "artifact");
  const rest = evidence.filter((item) => item.kind !== "artifact");
  const row = (item) => `<li class="evidence-row"><span class="evidence-kind">${escape(EVIDENCE_KIND[item.kind] ?? item.kind)}</span><code>${escape(item.locator ?? "")}</code><span>${escape((item.summary ?? "").slice(0, 160))}</span></li>`;
  const list = (items, limit) => items.slice(0, limit).map(row).join("") + (items.length > limit ? `<li class="evidence-more">另有 ${items.length - limit} 条</li>` : "");
  return `<details class="activity-card" data-disclosure="evidence" open>
    <summary class="activity-summary">${icon("check")}<b>证据与产物</b><span>${artifacts.length} 个产物 · ${rest.length} 条观察</span></summary>
    ${artifacts.length ? `<h5>产物</h5><ul class="evidence-list">${list(artifacts, 60)}</ul>` : ""}
    ${rest.length ? `<h5>证据</h5><ul class="evidence-list">${list(rest, 60)}</ul>` : ""}
    <p class="au-note">共 ${count} 条，来自 Journal 的 evidence.recorded。</p>
  </details>`;
}
function recalledMemoryMarkup(session) { const memories = session.recalledMemories || []; if (!memories.length) return ""; return `<details class="activity-card" data-disclosure="memory"><summary class="activity-summary">${icon("spark")}<b>本次任务使用的 Memory</b><span>${memories.length} 条</span></summary><div class="agent-list">${memories.map((memory) => `<div class="agent-row"><div><strong>${escape(memory.summary)}</strong><small>匹配：${escape((memory.matchedTerms || []).join("、") || "相关上下文")} · ${Math.round((memory.score || 0) * 100)}%</small></div></div>`).join("")}</div></details>`; }
function parentTitleOf(session) {
  const parentId = session.parentId ?? session.conversationId;
  if (typeof parentId !== "string" || parentId.length === 0) return "";
  if (parentId === MAIN_CONVERSATION_ID) return t("session-group-main");
  const parent = (state.dashboard?.sessions || []).find((item) => item.id === parentId);
  return parent ? shortName(plainPreview(parent.title), 32) : "";
}
function setTopbar(session) {
  if (!session) {
    $("session-kind").textContent = t("session-kind-new");
    $("session-title").textContent = t("new-conversation");
    $("session-subtitle").textContent = t("start-intent");
    $("session-status").textContent = t("ready");
    $("session-status").className = "status-pill";
    return;
  }
  const status = statusMeta(session.status);
  let kind;
  if (session.kind === "conversation") {
    kind = session.id === MAIN_CONVERSATION_ID ? t("session-kind-main") : t("session-kind-conversation");
  } else {
    // A task record is one level below its conversation. The breadcrumb names
    // that level; a run with no conversation names the 定时/自动 group.
    // 任务记录比它的对话低一层。面包屑点出这一层；没有对话的 Run 点出"定时/自动"。
    kind = `${parentTitleOf(session) || t("session-group-auto")} → ${t("session-kind-task")}`;
  }
  $("session-kind").textContent = kind;
  $("session-title").textContent = plainPreview(session.title);
  $("session-subtitle").textContent = `${plainPreview(session.preview)} · ${time(session.updatedAt)}`;
  $("session-status").textContent = session.kind === "conversation" && session.status === "completed" ? "已保存" : status.label;
  $("session-status").className = `status-pill ${status.className}`;
}
function traceMarkup(session) {
  const trace = session.trace || session.activity || [];
  if (!trace.length) return "";
  // The record is what the owner opens the task to read, finished or not, so
  // the trace starts open; the scroll container bounds a long one. A collapse
  // the owner made is remembered per session and still wins.
  // 无论是否已结束，记录都是所有者打开任务要读的东西，因此轨迹默认展开；长轨迹由滚动容器
  // 约束。所有者自己做过的折叠仍按会话记忆生效。
  const open = disclosureOpen(session, "trace", true) ? " open" : "";
  return `<details class="activity-card" data-disclosure="trace"${open}><summary class="activity-summary">${icon("check")}<b>本地执行轨迹</b><span>${trace.length} 条</span></summary><div class="trace" data-scroll-region="trace">${trace.map((item, index) => `<div class="trace-row"><b><span class="trace-sequence">#${item.sequence ?? index + 1}</span>${escape(item.label)}</b><p>${time(item.occurredAt)} · ${escape(item.detail)}</p></div>`).join("")}</div></details>`;
}
const SCROLL_BOTTOM_THRESHOLD = 28;
function rememberCurrentScroll() {
  if (!state.selectedId) return;
  const viewport = $("conversation");
  const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  state.scrollPositions.set(state.selectedId, {
    top: viewport.scrollTop,
    anchor: maxTop - viewport.scrollTop <= SCROLL_BOTTOM_THRESHOLD ? "bottom" : "offset",
  });
}
function rememberDisclosureScrolls() {
  if (!state.selectedId) return;
  const positions = state.disclosureScrollPositions.get(state.selectedId) || new Map();
  document.querySelectorAll("#conversation-inner [data-scroll-region]").forEach((region) => {
    positions.set(region.dataset.scrollRegion, region.scrollTop);
  });
  state.disclosureScrollPositions.set(state.selectedId, positions);
}
function rememberDisclosureScroll(event) {
  const region = event.target;
  if (!(region instanceof HTMLElement) || !region.dataset.scrollRegion || !state.selectedId) return;
  const positions = state.disclosureScrollPositions.get(state.selectedId) || new Map();
  positions.set(region.dataset.scrollRegion, region.scrollTop);
  state.disclosureScrollPositions.set(state.selectedId, positions);
}
function rememberDisclosure(event) {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.dataset.disclosure || !state.selectedId) return;
  const disclosures = state.openDisclosures.get(state.selectedId) || new Map();
  disclosures.set(details.dataset.disclosure, details.open);
  state.openDisclosures.set(state.selectedId, disclosures);
}
function restoreSessionScroll(id, { scrollToBottom = false } = {}) {
  const saved = scrollToBottom ? { top: 0, anchor: "bottom" } : state.scrollPositions.get(id) || { top: 0, anchor: "bottom" };
  requestAnimationFrame(() => {
    if (state.selectedId !== id) return;
    const viewport = $("conversation");
    const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const top = saved.anchor === "bottom" ? maxTop : Math.min(saved.top, maxTop);
    viewport.scrollTop = top;
    state.scrollPositions.set(id, { top, anchor: saved.anchor });
  });
}
function restoreDisclosureScrolls(id) {
  const positions = state.disclosureScrollPositions.get(id);
  if (!positions) return;
  requestAnimationFrame(() => {
    if (state.selectedId !== id) return;
    document.querySelectorAll("#conversation-inner [data-scroll-region]").forEach((region) => {
      const top = positions.get(region.dataset.scrollRegion);
      if (top !== undefined) region.scrollTop = Math.min(top, Math.max(0, region.scrollHeight - region.clientHeight));
    });
  });
}
/**
 * Brings the asked-for subagent row into view after its record renders. The
 * focus is one-shot: a later refresh of the same record must not keep scrolling
 * the owner back to a row they may have scrolled away from.
 * 在记录渲染后把被要求查看的子 Agent 行带入视野。焦点是一次性的：之后同一记录的刷新
 * 不得把所有者再次滚回他们可能已经滚开的那一行。
 */
function revealAgentFocus(id) {
  const focus = state.agentFocus;
  if (!focus || focus.runId !== id) return;
  state.agentFocus = null;
  requestAnimationFrame(() => {
    if (state.selectedId !== id) return;
    const row = document.querySelector("#conversation-inner [data-agent-focus]");
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.classList.add("is-revealed");
  });
}
function decisionDock(session) {
  // A waiting decision belongs at the top of the pane and stays there while the
  // owner scrolls: at the bottom of a long log it was easy to miss, and the
  // auto-scroll could leave it off-screen.
  // 等待中的决定属于面板顶部，并在滚动时留在那里：放在长日志底部容易被错过，
  // 自动滚动也可能把它留在视口之外。
  const cards = `${approvalMarkup(session)}${reviewMarkup(session)}`;
  return cards.length === 0 ? "" : `<div class="decision-dock">${cards}</div>`;
}
function dispatchSourceMarkup(session) {
  // A task record names the conversation it belongs to. The label shows the
  // parent's title (or a short id when the parent row is not in the payload),
  // and the button opens that conversation.
  // 任务记录标出它所属的对话。标签显示父对话标题（父行不在载荷里时显示短 id），按钮打开该对话。
  if (session.kind === "conversation") return "";
  const parentId = session.parentId ?? session.conversationId ?? session.dispatchedBy;
  if (typeof parentId !== "string" || parentId.length === 0) return "";
  const main = parentId === MAIN_CONVERSATION_ID;
  const sessions = typeof state === "undefined" ? [] : (state.dashboard?.sessions || []);
  const parent = sessions.find((item) => item.id === parentId);
  const label = main
    ? "来自主对话"
    : parent?.title
      ? `来自对话「${shortName(plainPreview(parent.title), 24)}」`
      : `来自对话 ${parentId.replace(/^conversation-/, "").slice(0, 12)}…`;
  return `<div class="dispatch-source"><span>所属对话</span><button type="button" class="dispatch-source-open" data-open-conversation="${escape(parentId)}" title="${escape(parentId)}">${escape(label)}</button></div>`;
}
function renderSession(session) { setTopbar(session); document.body.classList.toggle("empty-conversation", !session || !sessionHasContent(session)); const signature = session ? JSON.stringify(session) : "welcome"; if (state.signatures.conversation === signature) return; state.signatures.conversation = signature; const content = $("conversation-inner"); if (!session) { content.innerHTML = welcomeMarkup(); $("conversation").scrollTop = 0; return; } const conversation = session.kind === "conversation"; const conversationLog = conversation ? turnLogMarkup(session) : ""; const showWelcome = conversation && conversationLog.length === 0; content.innerHTML = showWelcome ? `${decisionDock(session)}${welcomeMarkup()}` : `<div class="day-divider">${day(session.updatedAt)}</div>${dispatchSourceMarkup(session)}${decisionDock(session)}${conversation ? conversationLog : session.messages.filter((message) => String(message.text ?? "").trim()).map(messageMarkup).join("")}${recalledMemoryMarkup(session)}${planMarkup(session)}${agentsMarkup(session)}${evidenceMarkup(session)}${verificationMarkup(session)}${traceMarkup(session)}`; restoreDisclosureScrolls(session.id); revealAgentFocus(session.id); requestAnimationFrame(updateScrollBottom); }
async function selectSession(id, { quiet = false, scrollToBottom = false, epoch = state.sessionEpoch } = {}) { if (!quiet) epoch = ++state.sessionEpoch; state.composingNew = false; state.newConversationId = null; if (!quiet) notifyDesktopNavigation("conversation"); if (state.selectedId !== id) { if (state.selectedId) state.drafts.set(state.selectedId, $("query").value); $("query").value = state.drafts.get(id) || ""; resizeComposer(); rememberCurrentScroll(); rememberDisclosureScrolls(); } state.selectedId = id; localStorage.setItem("clone-ai:selected-session", id); syncComposer(); renderSessions(state.dashboard?.sessions || []); try { const session = await api(`/api/sessions/${encodeURIComponent(id)}`); if (epoch !== state.sessionEpoch) return; renderSession(session); void hydrateTurnChoice(activeConversationId()); restoreSessionScroll(id, { scrollToBottom }); } catch (error) { if (epoch !== state.sessionEpoch) return; if (!quiet) announce(error.message, true); state.selectedId = null; localStorage.removeItem("clone-ai:selected-session"); renderSession(null); } }
async function refresh({ preserveScroll = true, scrollToBottom = false } = {}) {
  if (state.routing) return;
  // A selection is being read; its chips and the next paint matter more than a
  // background dashboard refresh. The five-second bound keeps a stuck file from
  // stopping every future refresh.
  // 正在读取选中的文件；chip 与下一次绘制比后台 Dashboard 刷新更重要。五秒上限
  // 避免一个卡住的文件让之后的刷新全部停止。
  if (state.attachmentsPreparing > 0 && performance.now() - state.attachmentsPreparingSince < 5000) return;
  // A live stream owns only the selected conversation's view; a background
  // turn in another task must not stop the sidebar from updating.
  // 运行中的流只拥有所选对话的视图；另一个任务的后台回合不应阻止侧栏更新。
  if (state.selectedId && state.streams.has(state.selectedId)) return;
  if (!state.selectedId && state.composingNew && state.newConversationId && state.streams.has(state.newConversationId)) return;
  // A slow tick must not overlap the next one: two refresh chains duplicate
  // twelve requests and their renders on the same main thread.
  // 慢的一次刷新不能与下一次重叠：两条刷新链会在同一主线程上重复十二个请求及其渲染。
  if (state.refreshing) return;
  state.refreshing = true;
  const epoch = state.sessionEpoch; if (preserveScroll) { rememberCurrentScroll(); rememberDisclosureScrolls(); } try { const [dashboard, schedules, settings, candidates, situation, config, connectors, library, context, opportunities, mobile] = await Promise.all([api("/api/dashboard"), api("/api/schedules"), api("/api/settings"), api("/api/memory/candidates"), api("/api/situation"), api("/api/config"), api("/api/connectors"), api("/api/memory/governed"), api("/api/context"), api("/api/opportunities"), api("/api/mobile/whatsapp")]); if (epoch !== state.sessionEpoch) return; state.dashboard = dashboard; const servedChoices = {}; for (const session of dashboard.sessions || []) { const choiceId = session.kind === "conversation" ? session.id : (session.conversationId || session.parentId); if (choiceId && session.turnChoice) servedChoices[choiceId] = session.turnChoice; } state.turnChoices = servedChoices; applyChrome(config.ui?.locale || config.config?.locale || "zh-CN", config.ui?.strings); renderSchedules(schedules.schedules || [], schedules.occurrences || [], schedules.reportDeliveries || [], schedules.reportError === true); renderSettings(settings); renderAudit(dashboard.sessions || []); renderLibrary(library); renderOpportunities(opportunities.opportunities || []); renderContext(context); renderMemoryCandidates(candidates.candidates || []); renderSituation(situation, config); renderWhatsApp(mobile.status); renderConnectors(connectors.connectors || []); if (!state.modelOptionsLoaded && !state.modelOptionsLoading) void loadModelOptions(); if (!state.gateways.length && !state.gatewayLoading) void refreshGateways(); const sessions = state.dashboard.sessions || []; const selectedIsConversation = state.selectedId === MAIN_CONVERSATION_ID || (state.selectedId?.startsWith("conversation-") ?? false) || (state.selectedId?.startsWith("whatsapp:") ?? false); if (!state.composingNew && (!state.selectedId || (!sessions.some((session) => session.id === state.selectedId) && !selectedIsConversation))) state.selectedId = sessions[0]?.id ?? null; renderSessions(sessions); if (state.composingNew) { state.selectedId = null; renderSession(null); } else if (state.selectedId) await selectSession(state.selectedId, { quiet: true, scrollToBottom, epoch }); else renderSession(null); requestAnimationFrame(() => { $("startup-screen").classList.add("ready"); document.querySelector(".app-shell").classList.add("ready"); }); } catch (error) { announce(error.message, true); const startupTip = document.querySelector("#startup-screen .startup-card span"); if (startupTip && !$("startup-screen").classList.contains("ready")) startupTip.textContent = `连接本地运行时失败：${error.message}（自动重试中…）`; } finally { state.refreshing = false; } }
function currentStream() {
  // The stream is keyed by the conversation, not by a task record opened from
  // it, so a child task and its parent share one send slot.
  // 流以对话为键，而不是以从对话打开的任务记录为键；子任务与父对话共用同一个发送槽位。
  const selected = (state.dashboard?.sessions || []).find((session) => session.id === state.selectedId);
  const conversationId = state.selectedId === MAIN_CONVERSATION_ID
    ? state.selectedId
    : selected?.kind === "conversation"
      ? selected.id
      : selected?.conversationId ?? selected?.parentId;
  if (conversationId !== undefined) return state.streams.get(conversationId);
  if (state.newConversationId) return state.streams.get(state.newConversationId);
  return state.streams.get(state.selectedId);
}
function stopActiveTurn() { currentStream()?.stop(); }
/**
 * The send slot reflects the selected conversation, not the whole window.
 * 发送槽位反映所选对话的状态，而不是整个窗口。
 */
function syncComposer() {
  const stream = currentStream();
  const submit = $("submit");
  const stop = $("stop-turn");
  if (submit) { submit.disabled = stream !== undefined; submit.hidden = stream !== undefined; }
  if (stop) stop.hidden = stream === undefined;
  renderComposerChoice();
}
async function createSession(query) { const button = $("submit"); button.disabled = true; rememberCurrentScroll();
  // Each task is its own Main Agent conversation: it carries its own history and
  // can run while another task's subtasks are still executing. A message sent
  // from a task record goes to the conversation that spawned it.
  // 每个任务都是自己的 Main Agent 对话：有自己的历史，可以在另一个任务的子任务仍在执行时
  // 运行。从任务记录发出的消息进入派生它的对话。
  const selectedSession = (state.dashboard?.sessions || []).find((session) => session.id === state.selectedId);
  // A task with no conversation has no thread to continue. Sending from its
  // record routes a new request instead of silently entering the main thread.
  // 没有对话的任务没有可续的线程；从它的记录发送会走新请求路由，而不是悄悄进入主线程。
  const standaloneTask = selectedSession !== undefined
    && selectedSession.kind !== "conversation"
    && selectedSession.conversationId === undefined
    && selectedSession.parentId === undefined;
  // A new request has no Main Agent yet: the router chooses one below. A
  // message sent inside a conversation (or under a child task) goes to that
  // conversation.
  // 新请求还没有 Main Agent：路由器在下方选择。在对话里（或子任务下）发送则进入该对话。
  let conversationId = state.composingNew || standaloneTask
    ? ""
    : selectedSession?.kind === "conversation"
      ? selectedSession.id
      : selectedSession?.conversationId ?? selectedSession?.parentId ?? "";
  if (conversationId && state.streams.has(conversationId)) {
    announce("这个任务仍在处理中；等它结束，或先停止它再发送。", true);
    syncComposer();
    return;
  }
  const wasComposing = state.composingNew || standaloneTask;
  const routeContext = state.routeContext
    ?? (standaloneTask ? { kind: "task", id: selectedSession.id } : null);
  state.routeContext = null;
  // The composer's pickers are the owner's choice for this turn. Read them
  // before the first await: a change made while routing belongs to the next
  // turn, not to this one.
  // 输入框的选择器代表所有者对本次请求的选择。在第一个 await 之前读取：路由期间改选
  // 属于下一回合，而不是这一回合。
  const sentChoice = readTurnChoice(activeConversationId());
  const ownedSelection = () => state.selectedId === conversationId
    || (state.composingNew && state.newConversationId === conversationId)
    || (standaloneTask && state.newConversationId === conversationId);
  // The message and a live reply card appear before the request is sent. A model
  // call can take many seconds, and until now the composer kept the text and the
  // conversation showed nothing, so the app looked frozen mid-thought.
  // 消息与实时回复卡片在请求发出之前就出现。模型调用可能耗时数秒，而此前输入框保留原文、
  // 会话区毫无变化，应用看起来就像在思考中卡住了。
  // The owner can press Enter while a selection is still being read. Wait for
  // the latest batch (a new batch may have started while we waited) so the file
  // is part of this message instead of appearing in the next one.
  // 选择仍在读取时，所有者就可能按回车。等待最新批次（等待期间可能又开始了新批次），
  // 让文件进入本条消息，而不是出现在下一条里。
  let waitedBatch;
  do { waitedBatch = attachmentBatch; await waitedBatch; } while (waitedBatch !== attachmentBatch);
  const outgoingAttachments = [...state.attachments];
  // A pending chip made the submit handler accept the Enter press, but every
  // file in the batch may have been rejected. Do not start an empty turn, and
  // keep the route context so a retry still goes to the intended conversation.
  // 占位 chip 让提交处理器接受了回车，但整批文件可能都被拒绝。不要启动空回合，并保留路由
  // 上下文，使重试仍进入预期的对话。
  if (query.length === 0 && outgoingAttachments.length === 0) {
    announce("请输入你想推进的事情，或添加图片/视频/文档。", true);
    state.routeContext = routeContext;
    syncComposer();
    return;
  }
  // The live card shares these preview URLs. A later removal from the composer
  // must not revoke a URL the connected card still displays; unload or a
  // replaced card releases it.
  // 实时卡片与输入框共用这些预览 URL。之后从输入框移除时，不能撤销已连接卡片仍在显示的
  // URL；由页面卸载或被替换的卡片释放。
  for (const item of outgoingAttachments) item.livePreview = true;
  // Start encoding before routing: the route decision may take a model round
  // trip, and the bytes can be prepared while it runs.
  // 在路由之前开始编码：路由决定可能要走一次模型往返，字节可以在它运行期间准备好。
  const attachmentRequest = attachmentsForRequest(outgoingAttachments);
  state.attachments = [];
  renderAttachments();
  $("query").value = ""; resizeComposer();
  document.body.classList.remove("empty-conversation");
  const inner = $("conversation-inner");
  const welcome = inner.querySelector(".welcome"); if (welcome) inner.innerHTML = "";
  const attachmentMarkup = outgoingAttachments.map((item) => item.kind === "document" || item.kind === "binary-document"
    ? `<div class="message-attachment-doc">${documentIcon}<span><b>${escape(shortName(item.name, 28))}</b><small>${escape(formatBytes(item.size))}</small></span></div>`
    : `<img src="${item.previewUrl}" alt="${escape(item.name)}" />`).join("");
  // The live turn already reads as an exchange: the owner's request is the
  // right-hand bubble, and the pending card plus the streamed reply sit in the
  // left-hand section. When the turn settles, the server's turn log renders the
  // same two sides, so settling does not change the conversation's shape.
  // 实时回合已经读成一次交流：所有者的请求是靠右的气泡，等待卡与流式回复在左侧章节里。
  // 回合结束后，服务端的回合日志渲染同样的两侧，因此落定不会改变对话的形状。
  const queryCard = document.createElement("article");
  queryCard.className = "turn-query";
  queryCard.setAttribute("aria-label", "你的请求");
  queryCard.innerHTML = `<div class="turn-query-bubble"><span class="turn-query-who">你</span><div class="turn-query-text">${richText(query || "（已发送附件）")}</div>${attachmentMarkup ? `<div class="message-attachments">${attachmentMarkup}</div>` : ""}</div>`;
  inner.appendChild(queryCard);
  const card = document.createElement("article"); card.className = "log-entry log-entry--live";
  card.dataset.logStatus = "started";
  card.innerHTML = `<div class="log-entry-head"><span class="log-entry-kicker">clone-ai</span><span class="log-badge log-badge--info" data-live-status>运行中</span><small>${time(new Date().toISOString())}</small></div><div class="log-entry-body"><div class="log-step"><span class="log-step-label">结果</span><div class="log-step-body"><div class="clone-card"><div class="response-pending" data-response-pending role="status" aria-live="polite"><span class="response-pending__pulse" aria-hidden="true"><i></i><i></i><i></i></span><div class="response-pending__copy"><strong data-pending-title>${escape(t("pending-connect-title"))}</strong><p data-pending-detail>${escape(t("pending-connect-detail"))}</p><div class="response-pending__track" aria-hidden="true"></div></div><span class="response-pending__time" data-pending-elapsed>${escape(t("pending-elapsed").replace("{seconds}", "0"))}</span></div><div class="tool-timeline" data-tool-timeline hidden></div><div class="clone-text" data-streaming="1" hidden></div></div></div></div></div>`;
  inner.appendChild(card);
  const target = card.querySelector(".clone-text");
  const liveStatus = card.querySelector("[data-live-status]");
  const pending = card.querySelector("[data-response-pending]");
  const pendingTitle = card.querySelector("[data-pending-title]");
  const pendingDetail = card.querySelector("[data-pending-detail]");
  const pendingElapsed = card.querySelector("[data-pending-elapsed]");
  const pendingStartedAt = performance.now();
  const pendingStages = [
    { at: 0, title: "pending-connect-title", detail: "pending-connect-detail" },
    { at: 4, title: "pending-think-title", detail: "pending-think-detail" },
    { at: 10, title: "pending-slow-title", detail: "pending-slow-detail" },
    { at: 20, title: "pending-long-title", detail: "pending-long-detail" },
  ];
  let pendingStage = -1;
  let pendingTimer = null;
  const updatePending = () => {
    const seconds = Math.max(0, Math.floor((performance.now() - pendingStartedAt) / 1000));
    const nextStage = pendingStages.reduce((selected, stage, index) => seconds >= stage.at ? index : selected, 0);
    if (nextStage !== pendingStage) {
      pendingStage = nextStage;
      pendingTitle.textContent = t(pendingStages[nextStage].title);
      pendingDetail.textContent = t(pendingStages[nextStage].detail);
      pending.dataset.phase = String(nextStage);
    }
    pendingElapsed.textContent = t("pending-elapsed").replace("{seconds}", String(seconds));
  };
  // A live tool timeline: the owner sees which tool ran, whether it was
  // refused, and how long it took, while the answer is still streaming.
  // 实时工具时间线：回答仍在流式输出时，所有者就能看到跑了哪个工具、是否被拒绝、耗时多少。
  const timeline = card.querySelector("[data-tool-timeline]");
  const timelineRows = new Map();
  const renderTimeline = () => {
    if (!timeline || timelineRows.size === 0) return;
    timeline.hidden = false;
    timeline.innerHTML = [...timelineRows.values()].map((row) => {
      const state = row.denied ? "denied" : row.isError ? "error" : row.phase === "completed" ? "done" : "running";
      const detail = row.durationMs === undefined ? "" : `${(row.durationMs / 1000).toFixed(1)}s`;
      return `<div class="tool-row" data-state="${state}"><span class="tool-dot" aria-hidden="true"></span><b>${escape(row.tool)}</b><span class="tool-state">${escape(t(`tool-state-${state}`))}</span><span class="tool-time">${escape(detail)}</span></div>`;
    }).join("");
  };
  const noteTool = (payload) => {
    const key = `${payload.tool}`;
    const previous = timelineRows.get(key) ?? { tool: payload.tool, phase: "started" };
    timelineRows.set(key, { ...previous, ...payload });
    renderTimeline();
  };
  const revealResponse = () => {
    if (pendingTimer !== null) {
      clearInterval(pendingTimer);
      pendingTimer = null;
    }
    if (pending && !pending.hidden) pending.hidden = true;
    target.hidden = false;
    target.classList.add("is-streaming");
  };
  updatePending();
  pendingTimer = window.setInterval(updatePending, 1000);
  $("conversation").scrollTop = $("conversation").scrollHeight;

  const turnId = globalThis.crypto?.randomUUID?.() || `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const turnStartedAt = new Date().toISOString();
  let reply = ""; let result = null; let failed = false; let failure = ""; let failureSummary = ""; let failureGuidance = ""; let stillOurs = false;
  const controller = new AbortController();
  // A user stop is not a timeout: the message says who ended the turn.
  // 用户停止不是超时：提示会说明是谁结束了回合。
  let stoppedByOwner = false;
  const stopTurn = () => {
    stoppedByOwner = true;
    controller.abort();
  };
  state.routing = false;
  let stallTimer = null;
  const armStallTimer = () => {
    if (stallTimer !== null) clearTimeout(stallTimer);
    stallTimer = window.setTimeout(() => controller.abort(), 180_000);
  };
  armStallTimer();
  try {
    const headers = { "content-type": "application/json" };
    if (window.CLONE_AI_TOKEN) headers["x-clone-ai-token"] = window.CLONE_AI_TOKEN;
    if (wasComposing) {
      // The owner typed a new request; Clone AI decides whether it continues a
      // conversation or starts a new Main Agent. The pending card is already
      // visible, so a model tie-break shows as normal thinking time.
      // 所有者输入的是一个新请求；由 Clone AI 判断它是继续某个对话还是新开 Main Agent。
      // 等待卡已经可见，因此模型裁决只表现为正常的思考时间。
      state.routing = true;
      try {
        const route = await api("/api/main-agent/route", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: query, turnId, ...(routeContext === null ? {} : { context: routeContext }) }),
        });
        conversationId = typeof route.conversationId === "string" && route.conversationId.length > 0
          ? route.conversationId
          : mintConversationId();
        state.newConversationId = conversationId;
        announce(route.decision === "continue" ? "clone-ai 判断这次沿用相关对话。" : "clone-ai 判断这次新开一个 Main Agent。");
      } catch {
        conversationId = mintConversationId();
        state.newConversationId = conversationId;
        announce("无法判断用哪个 Main Agent，已新开一个。", true);
      } finally {
        state.routing = false;
      }
    }
    if (!conversationId) conversationId = mintConversationId();
    // A conversation keeps its saved choice; an explicit pick in this composer
    // wins and becomes that conversation's choice. A new request without an
    // explicit pick adopts the choice of the conversation the router continued.
    // 对话沿用已保存的选择；本次输入框里的显式选择优先，并写回该对话。没有显式选择的
    // 新请求沿用路由命中的对话的选择。
    let turnModel = sentChoice.model;
    let turnEffort = sentChoice.effort;
    if (wasComposing) {
      const inherited = readTurnChoice(conversationId);
      if (turnModel === "" && turnEffort === "") {
        turnModel = inherited.model;
        turnEffort = inherited.effort;
      }
    }
    // Whatever actually runs belongs to this conversation, including an id
    // minted for the welcome screen; a turn that follows Settings keeps no
    // entry, so the conversation stays on the default.
    // 实际运行的选择属于这个对话，包括在欢迎页现场生成的 id；跟随设置的回合不写条目，
    // 对话保持默认。
    if (turnModel || turnEffort) writeTurnChoice(conversationId, { model: turnModel, effort: turnEffort });
    if (state.streams.has(conversationId)) throw new Error("这个对话仍在处理中；等它结束再发送。");
    state.streams.set(conversationId, { stop: stopTurn });
    syncComposer();
    const preparedAttachments = await attachmentRequest;
    if (!preparedAttachments.ok) throw new Error(preparedAttachments.error);
    const response = await fetch("/api/main-agent/stream", {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: query,
        turnId,
        conversationId,
        ...(turnModel ? { model: turnModel } : {}),
        ...(turnEffort ? { effort: turnEffort } : {}),
        ...(preparedAttachments.attachments.length === 0 ? {} : { attachments: preparedAttachments.attachments }),
      }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) { const detail = await response.json().catch(() => ({})); throw new Error(detail.error || `请求失败：${response.status}`); }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      armStallTimer();
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; a partial frame stays buffered.
      // SSE 帧以空行分隔；不完整的帧留在缓冲区等待后续数据。
      let split;
      while ((split = buffer.indexOf(String.fromCharCode(10, 10))) >= 0) {
        const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1]; const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (!event || !data) continue;
        const payload = JSON.parse(data);
        if (event === "delta") { revealResponse(); reply += payload.delta; target.textContent = reply; $("conversation").scrollTop = $("conversation").scrollHeight; }
        else if (event === "tool") { noteTool(payload); }
        else if (event === "queued") {
          // The server is waiting for a capacity slot; this is progress, not a
          // stall, and the owner should see why nothing is streaming yet.
          // 服务端在等容量槽位；这是进展而不是停滞，所有者应看到为什么还没有流式输出。
          armStallTimer();
          if (pendingDetail) pendingDetail.textContent = `正在等待空闲的 Main Agent 槽位（上限 ${payload.limit ?? "?"}）…`;
        }
        else if (event === "done") {
          result = payload;
          for (const report of payload.attachmentReports ?? []) {
            if (report.truncated) announce(t("attachment-truncated").replace("{name}", report.name).replace("{characters}", String(report.characters)));
          }
        }
        else if (event === "failed") {
          failure = payload.error || "Main Agent 调用失败。";
          failureSummary = payload.errorSummary || "";
          failureGuidance = payload.errorGuidance || "";
          throw new Error(failure);
        }
      }
    }
    if (!result) throw new Error("连接在回复完成前中断。");
    state.drafts.delete(state.selectedId);
    // Re-render the finished reply so links and code blocks are formatted; the
    // streaming view stays plain text because partial markdown renders wrong.
    // 回复完成后重新渲染，让链接与代码块获得格式；流式过程保持纯文本，因为不完整的
    // Markdown 会渲染错乱。
    const firstRun = result.newRuns?.[0];
    revealResponse();
    target.classList.remove("is-streaming");
    target.parentElement?.querySelector("[data-response-error]")?.remove();
    // Add the settled card only after its state is known. A transient error
    // or empty return must not leave a permanent composer inside the chat.
    // 状态确定后才显示最终卡片；异常或空返回绝不会在聊天里留下永久占位。
    target.hidden = false;
    target.innerHTML = reply.trim().length > 0
      ? richText(reply)
      : `<span class="response-fallback">${escape(t(firstRun ? "empty-model-reply-with-run" : "empty-model-reply"))}</span>`;
    if (liveStatus) { liveStatus.textContent = "完成"; liveStatus.className = "log-badge log-badge--ok"; }
    card.dataset.logStatus = "completed";
    // The turn lands in the conversation it was sent from; a plan it proposed
    // becomes a task under that conversation in the sidebar. A background
    // completion must not steal the conversation the owner is reading.
    // 回合落在它被发出的对话里；它提案的计划成为该对话下的侧栏任务。后台完成不得夺走所有者在
    // 读的对话。
    stillOurs = ownedSelection();
    if (stillOurs) {
      state.composingNew = false;
      state.newConversationId = null;
      state.selectedId = conversationId;
      state.drafts.delete(conversationId);
      localStorage.setItem("clone-ai:selected-session", conversationId);
    }
    if (firstRun) state.scrollPositions.set(firstRun.id, { top: 0, anchor: "bottom" });
    announce(firstRun ? "Main Agent 已提交计划，正在推进。" : "Main Agent 已回复（未创建任务）。");
  } catch (error) {
    failed = true;
    failure = error instanceof Error && error.name === "AbortError"
      ? stoppedByOwner ? t("turn-stopped") : "Main Agent 在 3 分钟内没有返回任何内容，已停止等待。"
      : error instanceof Error ? error.message : String(error);
    // The typed text is restored so a failed send never loses what was written.
    // 恢复已输入的文本，使一次失败的发送绝不丢失所写内容。
    if (!reply) {
      revealResponse();
      target.classList.remove("is-streaming");
      target.hidden = true;
      target.innerHTML = "";
      target.insertAdjacentHTML("afterend", failureSummary
        // The server sends the owner-facing summary with the failure; the raw
        // error stays available for diagnosis. Without a summary, keep the old
        // interrupted card.
        // 服务端随失败发送所有者可读的摘要；原始错误仍可用于诊断。没有摘要时保留旧的
        // 中断卡片。
        ? `<div class="log-error" data-response-error><b>错误</b><p>${escape(failureSummary)}</p>${failureGuidance ? `<p class="log-error-guidance">下一步：${escape(failureGuidance)}</p>` : ""}<details class="log-detail"><summary>原始错误</summary><pre>${escape(failure)}</pre></details></div>`
        : `<div class="response-error" data-response-error>${escape(t("response-interrupted-detail").replace("{message}", failure))}</div>`);
      if (liveStatus) { liveStatus.textContent = "失败"; liveStatus.className = "log-badge log-badge--bad"; }
      card.dataset.logStatus = "failed";
      // Restore into the composer only if the owner is still looking at this
      // conversation; otherwise keep the text as that task's draft.
      // 只有所有者仍看着这个对话时才把文本还回输入框；否则把它留作该任务的草稿。
      if (ownedSelection()) {
        $("query").value = query;
        resizeComposer();
        // A failed send must not also cost the owner the files they chose. Keep any
        // files attached during the failed turn and put the originals first, up
        // to the same four-attachment cap; the rest stay on the card's preview
        // and are released when it is replaced.
        // 发送失败不应连所有者选好的文件一起丢掉。保留失败回合期间新加的附件，把原附件放在
        // 前面，仍受四附件上限约束；未恢复的条目留在卡片的预览里，卡片被替换时释放。
        const merged = mergeRestoredAttachments(outgoingAttachments, state.attachments);
        if (merged !== state.attachments) {
          state.attachments = merged;
          renderAttachments();
        }
      } else {
        state.drafts.set(conversationId, query);
      }
    } else {
      revealResponse();
      target.classList.remove("is-streaming");
      target.innerHTML = richText(reply);
    }
    announce(failureSummary || failure, true);
  } finally {
    state.streams.delete(conversationId);
    syncComposer();
    if (stallTimer !== null) clearTimeout(stallTimer);
    if (pendingTimer !== null) clearInterval(pendingTimer);
    target.removeAttribute("data-streaming");
    target.classList.remove("is-streaming");
  }
  if (failed) {
    await api("/api/main-agent/interruptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId, text: query, error: failure, startedAt: turnStartedAt, conversationId }),
    }).catch(() => undefined);
    // A failed first send keeps its error card: refreshing would render the
    // welcome screen over it. Existing conversations can refresh normally.
    // 新任务首次发送失败时保留错误卡：刷新会用欢迎页盖掉它。已有对话可以正常刷新。
    if (!(wasComposing && !reply)) await refresh({ preserveScroll: true, scrollToBottom: true }).catch(() => undefined);
    releaseReplacedAttachmentPreviews(card, outgoingAttachments);
  }
  if (!failed) {
    // The stream is deleted in `finally`, so this refresh now actually runs;
    // before, the guard skipped it and the heavy rebuild landed on the next
    // three-second tick, possibly under the owner's next click.
    // 流在 `finally` 里删除，因此这次刷新现在真正执行；此前守卫会跳过它，繁重的重建落到
    // 下一个三秒 tick，可能正好压在所有者的下一次点击之下。
    await refresh({ preserveScroll: false, scrollToBottom: stillOurs }).catch(() => undefined);
    releaseReplacedAttachmentPreviews(card, outgoingAttachments);
  }
}

async function approve(id) { const button = document.querySelector(`[data-approve="${CSS.escape(id)}"]`); if (button) button.disabled = true; try { const result = await api(`/api/runs/${encodeURIComponent(id)}/approve`, { method: "POST" }); await refresh({ preserveScroll: true, scrollToBottom: true }); announce(result.status === "completed" ? "已完成并验证结果。" : "已记录确认，继续处理中。" ); } catch (error) { if (button) button.disabled = false; announce(error.message, true); } }
async function reject(id) { const button = document.querySelector(`[data-reject="${CSS.escape(id)}"]`); if (button) button.disabled = true; try { await api(`/api/runs/${encodeURIComponent(id)}/reject`, { method: "POST" }); await refresh({ preserveScroll: true, scrollToBottom: true }); announce("已拒绝这次外部动作。"); } catch (error) { if (button) button.disabled = false; announce(error.message, true); } }
async function reviewResult(id, decision) { const message = decision === "accept" ? t("review-accept-confirm") : t("review-reject-confirm"); if (!(await confirmDialog(message, t("confirm")))) return; try { const result = await api(`/api/runs/${encodeURIComponent(id)}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) }); await refresh({ preserveScroll: true, scrollToBottom: true }); announce(result.status === "waiting_review" ? t("status-review") : t("review-saved")); } catch (error) { announce(error.message, true); } }
function resizeComposer() { const input = $("query"); input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 132)}px`; }
function renderScheduleOptions() { const kind = $("schedule-kind").value; const options = $("schedule-options"); $("schedule-time").hidden = kind === "interval"; $("schedule-time").required = kind !== "interval"; if (kind === "interval") { options.innerHTML = `<label>每隔</label><input id="schedule-interval-value" type="number" min="1" max="10080" value="30" aria-label="间隔时长"/><select id="schedule-interval-unit" aria-label="间隔单位"><option value="1">分钟</option><option value="60">小时</option></select><span class="schedule-cron-help">按固定间隔触发，例如每隔 5 分钟；首次触发要等一个间隔，客户端关闭期间错过的不会补跑。</span>`; return; } if (kind === "weekly") { options.innerHTML = `<label>在这些日子执行：</label>${["日", "一", "二", "三", "四", "五", "六"].map((day, index) => `<label><input type="checkbox" name="schedule-weekday" value="${index}" ${index === 1 ? "checked" : ""}/>周${day}</label>`).join("")}`; return; } if (kind === "monthly") { options.innerHTML = `<label>每月 <input id="schedule-day" type="number" min="1" max="31" value="1"/> 日</label>`; return; } if (kind === "yearly") { options.innerHTML = `<label>每年 <select id="schedule-month">${Array.from({ length: 12 }, (_, index) => `<option value="${index + 1}">${index + 1} 月</option>`).join("")}</select><input id="schedule-day" type="number" min="1" max="31" value="1"/> 日</label>`; return; } options.innerHTML = `<span class="schedule-cron-help">每天在所选时间触发；如果客户端稍后启动，当天会补触发一次。</span>`; }
function openSchedules() { notifyDesktopNavigation("schedules"); $("schedule-modal").setAttribute("aria-hidden", "false"); renderScheduleOptions(); $("schedule-query").focus(); }
function focusComposerIfVisible() {
  setTimeout(() => {
    const settingsOpen = $("settings-modal").getAttribute("aria-hidden") === "false";
    const schedulesOpen = $("schedule-modal").getAttribute("aria-hidden") === "false";
    if (!settingsOpen && !schedulesOpen && !document.body.classList.contains("sidebar-open")) $("query").focus();
  }, 40);
}
function closeSchedules() { $("schedule-modal").setAttribute("aria-hidden", "true"); notifyDesktopNavigation("conversation"); focusComposerIfVisible(); }
function selectSettingsSection(section, forceReset = false, options = {}) {
  const content = document.querySelector(".settings-content");
  const previous = state.settingsSection;
  const changed = forceReset || previous !== section;
  // Each panel keeps its own scroll position, so moving between tabs does not
  // throw away where the owner was reading.
  // 每个分区记住自己的滚动位置，切换标签不会把所有者正在读的位置丢掉。
  state.settingsScroll = state.settingsScroll || new Map();
  if (changed && content && previous !== undefined) state.settingsScroll.set(previous, content.scrollTop);
  state.settingsSection = section;
  document.querySelectorAll("[data-settings-section]").forEach((button) => {
    const active = button.dataset.settingsSection === section;
    button.setAttribute("aria-selected", String(active));
    button.setAttribute("aria-current", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    const active = panel.dataset.settingsPanel === section;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
    panel.setAttribute("aria-hidden", String(!active));
  });
  if (content) {
    content.scrollTop = changed ? (state.settingsScroll.get(section) ?? 0) : content.scrollTop;
    const panel = document.querySelector(`[data-settings-panel="${section}"]`);
    if (changed && panel && options.animate !== false) {
      panel.classList.remove("is-entering");
      void panel.offsetWidth;
      panel.classList.add("is-entering");
    }
  }
  notifyDesktopNavigation(section === "agents" ? "agents" : section === "memory" ? "memory" : "settings");
  if (section === "agents" && !state.gatewayLoading) void refreshGateways();
  if (section === "tools") void refreshToolsCatalog();
  if (section === "safety" && state.authority === null && !state.authorityLoading) void refreshAuthority();
}
function settingsTabs() { return [...document.querySelectorAll("[data-settings-section]")]; }

function moveSettingsFocus(direction) {
  const tabs = settingsTabs();
  if (tabs.length === 0) return;
  const current = tabs.findIndex((tab) => tab.dataset.settingsSection === state.settingsSection);
  const next = direction === "home" ? 0 : direction === "end" ? tabs.length - 1 : (current + (direction === "next" ? 1 : -1) + tabs.length) % tabs.length;
  const target = tabs[next];
  if (target === undefined) return;
  selectSettingsSection(target.dataset.settingsSection);
  target.focus();
}

function openSettings() { selectSettingsSection(state.settingsSection); $("settings-modal").setAttribute("aria-hidden", "false"); }
function closeSettings() { $("settings-modal").setAttribute("aria-hidden", "true"); notifyDesktopNavigation("conversation"); focusComposerIfVisible(); }
async function createSchedule(query) { const button = $("schedule-create"); const kind = $("schedule-kind").value; const body = { query, kind, time: $("schedule-time").value }; if (kind === "weekly") body.weekdays = [...document.querySelectorAll('input[name="schedule-weekday"]:checked')].map((input) => Number(input.value)); if (kind === "monthly" || kind === "yearly") body.dayOfMonth = Number($("schedule-day").value); if (kind === "yearly") body.month = Number($("schedule-month").value); if (kind === "interval") body.intervalMinutes = Math.max(1, Math.floor(Number($("schedule-interval-value").value) || 0)) * Number($("schedule-interval-unit").value); button.disabled = true; try { await api("/api/schedules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); $("schedule-query").value = ""; await refresh(); announce("定时任务已保存到本地运行时。"); } catch (error) { announce(error.message, true); } finally { button.disabled = false; } }
async function setScheduleEnabled(id, enabled) { try { await api(`/api/schedules/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }); await refresh(); announce(enabled ? "定时任务已启用。" : "定时任务已暂停。"); } catch (error) { announce(error.message, true); } }
async function resolveScheduleOccurrence(id, resolution) { const message = resolution === "retry" ? t("schedule-retry-confirm") : t("schedule-dismiss-confirm"); if (!(await confirmDialog(message, t("confirm")))) return; try { await api(`/api/schedules/occurrences/${encodeURIComponent(id)}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolution }) }); await refresh(); announce(t("schedule-resolved")); } catch (error) { announce(error.message, true); } }
async function resolveReportDelivery(day, resolution) { const message = resolution === "retry" ? t("report-retry-confirm") : t("report-dismiss-confirm"); if (!(await confirmDialog(message, t("confirm")))) return; try { await api(`/api/reporting/deliveries/${encodeURIComponent(day)}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolution, confirmChecked: true }) }); await refresh(); announce(t("schedule-resolved")); } catch (error) { await refresh(); announce(error.message, true); } }
async function searchMemories(query) { try { const result = await api(`/api/memory/governed/recall?q=${encodeURIComponent(query)}`); renderMemorySearch(result.matches || []); } catch (error) { announce(error.message, true); } }
function confirmDialog(message, okLabel) { return new Promise((resolve) => { const modal = $("confirm-modal"); $("confirm-message").textContent = message; const ok = $("confirm-ok"); ok.textContent = okLabel || "确认"; modal.setAttribute("aria-hidden", "false"); const done = (result) => { modal.setAttribute("aria-hidden", "true"); ok.onclick = $("confirm-cancel").onclick = modal.onclick = null; resolve(result); }; ok.onclick = () => done(true); $("confirm-cancel").onclick = () => done(false); modal.onclick = (event) => { if (event.target === modal) done(false); }; }); }
async function restoreConversation(id) {
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}/restore`, { method: "POST" });
    await refresh({ preserveScroll: false });
    announce("对话及其任务已恢复。");
  } catch (error) { announce(error.message, true); }
}

async function deleteSession(id) {
  // The main conversation is the pinned entry to the owner's original thread;
  // hiding it would leave the sidebar without it until a restore.
  // 主对话是所有者最初线程的固定入口；隐藏它会让侧栏失去这个入口，直到恢复。
  if (id === MAIN_CONVERSATION_ID) { announce("主对话始终保留在列表中。", true); return; }
  const session = (state.dashboard?.sessions || []).find((item) => item.id === id); const message = session?.kind === "conversation" ? `隐藏这个对话？它的 ${session?.childCount || 0} 个任务会一起隐藏。审计日志、记忆和备份不受影响，随时可以恢复。` : session?.parentId ? "隐藏这条任务？它会从所属对话中隐藏，审计记录会保留。" : "从列表隐藏这条任务？这不会删除本机审计日志、记忆或备份。"; if (!(await confirmDialog(message, "隐藏"))) return; try { await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }); state.scrollPositions.delete(id); state.openDisclosures.delete(id); state.disclosureScrollPositions.delete(id); if (state.selectedId === id) { state.selectedId = null; localStorage.removeItem("clone-ai:selected-session"); } await refresh({ preserveScroll: false }); announce("会话已从列表隐藏；数据仍然保留。"); } catch (error) { announce(error.message, true); } }
$("session-list").addEventListener("click", (event) => { const restore = event.target.closest("[data-restore-conversation]"); if (restore) { void restoreConversation(restore.dataset.restoreConversation); return; } const remove = event.target.closest("[data-delete-session]"); if (remove) { void deleteSession(remove.dataset.deleteSession); return; } const button = event.target.closest("[data-session]"); if (button) { closeSchedules(); closeSettings(); setSidebarOpen(false); void selectSession(button.dataset.session); } });
$("conversation-inner").addEventListener("click", (event) => { const suggestion = event.target.closest("[data-suggestion]"); if (suggestion) { $("query").value = suggestion.dataset.suggestion; resizeComposer(); $("query").focus(); } const agentSettings = event.target.closest("[data-open-agent-settings]"); if (agentSettings) { notifyDesktopNavigation("agents"); openSettings(); selectSettingsSection("agents"); return; } const turnAudit = event.target.closest("[data-open-turn-audit]"); if (turnAudit) { openSettings(); selectSettingsSection("audit"); window.CloneAudit?.showTurns?.(turnAudit.dataset.openTurnAudit || "", turnAudit.dataset.openTurnConversation || ""); return; } const agentRun = event.target.closest("[data-open-agent-run]"); if (agentRun) { state.agentFocus = { runId: agentRun.dataset.openAgentRun, agentId: agentRun.dataset.agentId }; void selectSession(agentRun.dataset.openAgentRun); return; } const openConversation = event.target.closest("[data-open-conversation]"); if (openConversation) { void selectSession(openConversation.dataset.openConversation, { scrollToBottom: true }); return; } const approval = event.target.closest("[data-approve]"); if (approval) void approve(approval.dataset.approve); const rejection = event.target.closest("[data-reject]"); if (rejection) void reject(rejection.dataset.reject); const review = event.target.closest("[data-review]"); if (review) void reviewResult(review.dataset.review, review.dataset.reviewDecision); const tableExport = event.target.closest("[data-export-table]"); if (tableExport) { exportMarkdownTable(tableExport.dataset.exportCsv || ""); return; } const copyButton = event.target.closest("[data-copy-code]"); if (copyButton) { const code = copyButton.parentElement?.querySelector("code"); if (code) void navigator.clipboard.writeText(code.textContent || "").then(() => { copyButton.textContent = "已复制"; setTimeout(() => { copyButton.textContent = "复制"; }, 1500); }).catch(() => announce("复制失败，请手动选中代码复制。", true)); } const expand = event.target.closest("[data-expand]"); if (expand) { const text = expand.parentElement?.querySelector(".clone-text"); if (text) { const collapsed = text.classList.toggle("collapsed"); expand.textContent = collapsed ? "展开全部" : "收起"; } } });
$("conversation-inner").addEventListener("toggle", rememberDisclosure, true);
$("conversation-inner").addEventListener("scroll", rememberDisclosureScroll, true);
document.querySelector(".settings-nav")?.addEventListener("keydown", (event) => {
  const key = event.key;
  const moves = { ArrowDown: "next", ArrowRight: "next", ArrowUp: "previous", ArrowLeft: "previous", Home: "home", End: "end" };
  const direction = moves[key];
  if (direction === undefined) return;
  event.preventDefault();
  moveSettingsFocus(direction);
});
document.querySelector(".settings-nav")?.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-settings-section]");
  if (tab) tab.focus();
});
$("settings-panel-tools")?.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-tool-toggle]");
  if (toggle) {
    void toggleMcpServer(toggle.dataset.toolToggle, toggle.dataset.toolEnabled === "true");
    return;
  }
  const remove = event.target.closest("[data-tool-remove]");
  if (remove) {
    void removeMcpServerFromUi(remove.dataset.toolRemove);
    return;
  }
  if (event.target.closest("#tool-install-probe")) {
    void probeInstall();
    return;
  }
  if (event.target.closest("#tool-install-confirm")) {
    void installMcpServerFromUi();
    return;
  }
  if (event.target.closest("#tool-market-probe")) {
    void probeMarketEntry();
    return;
  }
  if (event.target.closest("#tool-market-install")) {
    void installFromMarket();
    return;
  }
  const skillInstall = event.target.closest("#skill-market-install");
  if (skillInstall) {
    void installSkillFromUi(skillInstall.dataset.skillInstall);
    return;
  }
  const preset = event.target.closest("[data-install-preset]");
  if (preset) {
    // A preset assigns one risk to every probed tool in this form; the owner
    // can still change a single row afterwards.
    // 预设把同一个风险赋给本例中每个探测到的工具；所有者之后仍可单独修改某一行。
    const host = preset.closest(".tool-install-tools");
    for (const select of host?.querySelectorAll("[data-install-risk]") ?? []) select.value = preset.dataset.installPreset;
    return;
  }
  const serverDetail = event.target.closest("[data-tool-detail]");
  if (serverDetail) {
    openToolsView({ kind: "server", id: serverDetail.dataset.toolDetail });
    return;
  }
  const marketButton = event.target.closest("[data-tools-market]");
  if (marketButton) {
    openToolsMarket(marketButton.dataset.toolsMarket);
    return;
  }
  const marketOpen = event.target.closest("[data-market-open]");
  if (marketOpen) {
    openToolsView({ kind: "mcp-entry", id: marketOpen.dataset.marketOpen });
    return;
  }
  const skillEntry = event.target.closest("[data-skill-entry]");
  if (skillEntry) {
    openToolsView({ kind: "skill-entry", name: skillEntry.dataset.skillEntry });
    return;
  }
  const skillDetail = event.target.closest("[data-skill-detail]");
  if (skillDetail) {
    openToolsView({ kind: "skill", name: skillDetail.dataset.skillDetail });
    return;
  }
  const skillRemove = event.target.closest("[data-skill-remove]");
  if (skillRemove) {
    void removeSkillFromUi(skillRemove.dataset.skillRemove);
    return;
  }
  if (event.target.closest("[data-tools-back]")) {
    backToolsView();
    return;
  }
  if (event.target.closest("[data-tools-refresh]")) {
    void refreshToolsCatalog();
    if (state.toolsMarketLoaded) void refreshToolsMarket();
    if (state.skillsMarketLoaded) void refreshSkillMarket();
  }
});
let toolsMarketSearchTimer;
let skillsMarketSearchTimer;
$("settings-panel-tools")?.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.id === "tools-market-search") {
    clearTimeout(toolsMarketSearchTimer);
    const value = target.value;
    toolsMarketSearchTimer = setTimeout(() => { void refreshToolsMarket(value); }, 160);
  } else if (target.id === "skills-market-search") {
    clearTimeout(skillsMarketSearchTimer);
    const value = target.value;
    skillsMarketSearchTimer = setTimeout(() => { void refreshSkillMarket(value); }, 160);
  }
});
document.querySelector(".settings-content")?.addEventListener("scroll", (event) => {
  const content = event.currentTarget;
  if (!(content instanceof HTMLElement) || state.settingsSection === undefined) return;
  state.settingsScroll = state.settingsScroll || new Map();
  state.settingsScroll.set(state.settingsSection, content.scrollTop);
}, { passive: true });
$("authority-root").addEventListener("change", (event) => {
  const select = event.target.closest("[data-authority-domain]");
  if (select) void setAuthorityDomain(select.dataset.authorityDomain, select.value);
});
$("authority-root").addEventListener("click", (event) => {
  const button = event.target.closest("[data-authority-revoke]");
  if (button) void revokeAuthorityPolicy(button.dataset.authorityRevoke);
});
$("authority-root").addEventListener("submit", (event) => {
  if (event.target.id !== "authority-policy-form") return;
  event.preventDefault();
  void addAuthorityPolicy(event.target);
});
$("data-export-choose").addEventListener("click", () => void exportOwnerDataFromDesktop());
$("data-export-reveal").addEventListener("click", revealExport);
$("config-locale")?.addEventListener("change", () => void saveLocale());
$("connector-add").addEventListener("click", () => void addConnector());
$("connector-list").addEventListener("click", (event) => { const remove = event.target.closest("[data-connector-remove]"); if (remove) void removeConnector(remove.dataset.connectorRemove); });
$("connector-list").addEventListener("change", (event) => { const toggle = event.target.closest("[data-connector-toggle]"); if (toggle) void setConnectorEnabled(toggle.dataset.connectorToggle, toggle.checked); });
$("schedule-open").addEventListener("click", openSchedules);
$("mobile-open").addEventListener("click", openMobileBinding);
$("schedule-close").addEventListener("click", closeSchedules);
function setSidebarOpen(open) { document.body.classList.toggle("sidebar-open", open); }
$("menu-open").addEventListener("click", () => setSidebarOpen(true));
$("sidebar-backdrop").addEventListener("click", () => setSidebarOpen(false));
$("settings-close").addEventListener("click", closeSettings);
$("settings-modal").addEventListener("click", (event) => { const button = event.target.closest("[data-settings-section]"); if (button) selectSettingsSection(button.dataset.settingsSection); });
$("whatsapp-binding-form").addEventListener("submit", (event) => { event.preventDefault(); void saveWhatsAppBinding(); });
$("whatsapp-binding-form").addEventListener("input", () => { state.whatsappDirty = true; });
$("whatsapp-verify").addEventListener("click", () => void verifyWhatsAppBinding());
$("whatsapp-stop-bridge").addEventListener("click", () => void stopWhatsAppBridge());
$("whatsapp-generate-token").addEventListener("click", generateWhatsAppVerifyToken);
$("whatsapp-copy-token").addEventListener("click", () => void copyText($("whatsapp-verify-token").value, "Verify Token 已复制。"));
$("whatsapp-start-tunnel").addEventListener("click", () => void startWhatsAppTunnel());
$("whatsapp-stop-tunnel").addEventListener("click", () => void stopWhatsAppTunnel());
$("whatsapp-install-cloudflared").addEventListener("click", () => void installCloudflared());
$("whatsapp-copy-webhook").addEventListener("click", () => void copyText(state.whatsapp?.tunnel?.webhookUrl || "", "Webhook 地址已复制。"));
$("whatsapp-open-meta").addEventListener("click", openMetaDeveloperConsole);
$("schedule-form").addEventListener("submit", (event) => { event.preventDefault(); void createSchedule($("schedule-query").value.trim()); });
$("schedule-kind").addEventListener("change", renderScheduleOptions);
$("schedule-list").addEventListener("click", (event) => { const report = event.target.closest("[data-report-day]"); if (report) { void resolveReportDelivery(report.dataset.reportDay, report.dataset.resolution); return; } const occurrence = event.target.closest("[data-schedule-occurrence]"); if (occurrence) { void resolveScheduleOccurrence(occurrence.dataset.scheduleOccurrence, occurrence.dataset.resolution); return; } const button = event.target.closest("[data-schedule-toggle]"); if (button) void setScheduleEnabled(button.dataset.scheduleToggle, button.dataset.scheduleEnabled === "true"); });
$("agent-page").addEventListener("click", (event) => {
  const refresh = event.target.closest("[data-settings-refresh], [data-gateway-refresh]");
  if (refresh) { void refreshGateways({ announceFailure: true }); return; }
  const applyGateway = event.target.closest("[data-gateway-apply]");
  if (applyGateway) { void useGatewayModel(); return; }
  const clearGateway = event.target.closest("[data-gateway-clear]");
  if (clearGateway) { void clearGatewayModel(); return; }
});
$("audit-session-list").addEventListener("click", (event) => { const button = event.target.closest("[data-open-audit-run]"); if (button) { closeSettings(); void selectSession(button.dataset.openAuditRun); } });
$("memory-candidates").addEventListener("click", (event) => { const promote = event.target.closest("[data-promote-candidate]"); if (promote) { void decideCandidate(promote.dataset.promoteCandidate, "promote"); return; } const reject = event.target.closest("[data-reject-candidate]"); if (reject) void decideCandidate(reject.dataset.rejectCandidate, "reject"); });
$("library-list").addEventListener("click", (event) => { const conflict = event.target.closest("[data-memory-conflict]"); if (conflict) { void keepMemoryFile(conflict.dataset.memoryConflict); return; } const save = event.target.closest("[data-save-library]"); if (save) { void saveLibraryMemory(save.dataset.saveLibrary); return; } const source = event.target.closest("[data-open-memory-source]"); if (source) { closeSettings(); void selectSession(source.dataset.openMemorySource); } });
$("library-create").addEventListener("click", () => void createLibraryMemory());
$("opportunity-strip").addEventListener("click", (event) => { const toggle = event.target.closest("[data-toggle-opportunities]"); if (toggle) { toggleOpportunities(); return; } const settings = event.target.closest("[data-open-failure-settings]"); if (settings) { notifyDesktopNavigation("agents"); openSettings(); selectSettingsSection("agents"); return; } const accept = event.target.closest("[data-accept-opportunity]"); if (accept) { void decideOpportunity(accept.dataset.acceptOpportunity, "accept"); return; } const dismiss = event.target.closest("[data-dismiss-opportunity]"); if (dismiss) void decideOpportunity(dismiss.dataset.dismissOpportunity, "dismiss"); });
$("context-search-form").addEventListener("submit", (event) => { event.preventDefault(); const query = $("context-search-query").value.trim(); if (query.length === 0) { announce("请输入内容来搜索历史。", true); return; } void searchContextHistory(query); });
$("memory-search-form").addEventListener("submit", (event) => { event.preventDefault(); const query = $("memory-search-query").value.trim(); if (query.length === 0) { announce("请输入内容来测试检索。", true); return; } void searchMemories(query); });
$("new-session").addEventListener("click", () => { state.sessionEpoch += 1; notifyDesktopNavigation("conversation"); closeSchedules(); closeSettings(); setSidebarOpen(false); rememberCurrentScroll(); const selected = (state.dashboard?.sessions || []).find((session) => session.id === state.selectedId); const selectedConversation = state.selectedId === MAIN_CONVERSATION_ID || (state.selectedId?.startsWith("conversation-") ?? false) || (state.selectedId?.startsWith("whatsapp:") ?? false) ? state.selectedId : selected?.conversationId ?? selected?.parentId; state.routeContext = selectedConversation ? { kind: "conversation", id: selectedConversation } : null; state.routing = false; if (state.selectedId) state.drafts.set(state.selectedId, $("query").value); state.composingNew = true; state.newConversationId = null; $("query").value = ""; resizeComposer(); state.selectedId = null; localStorage.removeItem("clone-ai:selected-session"); syncComposer(); renderSessions(state.dashboard?.sessions || []); renderSession(null); $("query").focus(); });
$("stop-turn").addEventListener("click", () => stopActiveTurn());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && currentStream() !== undefined) { event.preventDefault(); stopActiveTurn(); }
});
$("request-form").addEventListener("submit", (event) => { event.preventDefault(); const query = $("query").value.trim(); if (query.length === 0 && state.attachments.length === 0 && state.attachmentsPending.length === 0) { announce("请输入你想推进的事情，或添加图片/视频/文档。", true); return; } void createSession(query); });
$("composer-model").addEventListener("change", saveComposerChoice);
$("composer-effort").addEventListener("change", saveComposerChoice);
$("query").addEventListener("input", resizeComposer);
$("query").addEventListener("paste", async (event) => {
  // The decision to take over the paste must be synchronous: an await before
  // preventDefault lets WebKit insert the clipboard's text (the bare names of
  // Finder-copied files) before the attachments are built.
  // 是否接管这次粘贴必须同步决定：在 preventDefault 之前 await，会让 WebKit 先把剪贴板
  // 文本（Finder 复制文件的裸文件名）插进去，附件随后才构建。
  const clipboard = event.clipboardData;
  const allFiles = clipboardFileObjects(clipboard);
  const cachedPaths = cachedClipboardFilePaths();
  const plainText = clipboard?.getData("text/plain") ?? "";
  // A stale cache is worse than no cache: if the clipboard's text names none of
  // the cached files, the owner copied something else while the app stayed
  // active, so fall back to the browser's normal paste.
  // 过期缓存比没有缓存更糟：如果剪贴板文本不含任何缓存文件的名字，说明 App 保持激活时所有者
  // 复制了别的东西，退回浏览器正常的粘贴。
  const pathsMatchClipboard = cachedPaths.length > 0
    && (plainText.trim().length === 0 || cachedPaths.some((path) => plainText.includes(basenameOfPath(path))));
  const pastedPaths = pathsMatchClipboard ? cachedPaths : [];
  // A Finder image keeps its real name (its path is known); a screenshot or a
  // nameless bitmap still gets the stable screenshot name.
  // Finder 图片保留真实名称（路径已知）；截图或无名位图仍使用稳定的截图名。
  const imageFiles = clipboardAttachmentFiles(clipboard, { preserve: new Set(pastedPaths.map(basenameOfPath)) });
  const documentFiles = allFiles.filter((file) => !/^image\//.test(file.type));
  if (imageFiles.length === 0 && pastedPaths.length === 0 && documentFiles.length === 0) {
    clearCachedClipboardFilePaths();
    return;
  }
  event.preventDefault();
  clearCachedClipboardFilePaths();
  // A screenshot or a Finder file WebKit exposed as a File is attached
  // directly. A Finder copy exposed only as file URLs gets its bytes from the
  // native reader, so the paste becomes a chip instead of path text. Only a
  // file that cannot become an attachment keeps its absolute path, which
  // read_file can open.
  // 截图或 WebKit 以 File 暴露的 Finder 文件直接作为附件。只以文件 URL 暴露的 Finder 复制
  // 由原生读取器提供字节，粘贴因此成为 chip 而不是路径文本。只有无法成为附件的文件保留
  // 绝对路径，供 read_file 打开。
  const filesToAttach = [...imageFiles, ...documentFiles];
  if (pastedPaths.length > 0) {
    const represented = new Set([...allFiles.map((file) => file.name), ...filesToAttach.map((file) => file.name)]);
    const missing = pastedPaths.filter((path) => !represented.has(basenameOfPath(path)));
    if (missing.length > 0) {
      for (const file of await nativeClipboardFiles()) {
        if (!filesToAttach.some((existing) => existing.name === file.name && existing.size === file.size)) filesToAttach.push(file);
      }
    }
  }
  const added = filesToAttach.length > 0 ? await addAttachmentFiles(filesToAttach) : 0;
  const facts = [];
  if (added > 0) facts.push(`${added} 个附件`);
  const fallbackPaths = pastedPaths.filter((path) => {
    const name = basenameOfPath(path);
    const candidate = filesToAttach.find((file) => file.name === name);
    if (candidate === undefined) return true;
    return !state.attachments.some((item) => item.name === candidate.name && item.size === candidate.size);
  });
  if (fallbackPaths.length > 0) {
    insertComposerText(fallbackPaths.join("\n"));
    facts.push(`${fallbackPaths.length} 个文件路径（无法作为附件读取）`);
  }
  if (facts.length > 0) announce(`已从剪贴板添加 ${facts.join("、")}。`);
  $("query").focus();
});
$("query").addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey) void refreshClipboardFilePaths();
}, true);
window.addEventListener("focus", () => { void refreshClipboardFilePaths(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshClipboardFilePaths(); });
$("attach").addEventListener("click", () => $("attachments").click());
$("attachments").addEventListener("change", (event) => { const input = event.target; const files = Array.from(input.files || []); input.value = ""; void addAttachmentFiles(files); });
$("attachment-preview").addEventListener("click", (event) => { const remove = event.target.closest("[data-remove-attachment]"); if (!remove) return; const [item] = state.attachments.splice(Number(remove.dataset.removeAttachment), 1); if (item?.livePreview !== true) releaseAttachmentPreview(item); renderAttachments(); });
window.addEventListener("beforeunload", () => { for (const url of attachmentPreviewUrls) URL.revokeObjectURL(url); attachmentPreviewUrls.clear(); });
function dragCarriesFiles(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}
let fileDragDepth = 0;
window.addEventListener("dragenter", (event) => {
  if (!dragCarriesFiles(event)) return;
  event.preventDefault();
  fileDragDepth += 1;
  document.body.classList.add("dragging-files");
});
window.addEventListener("dragover", (event) => {
  if (!dragCarriesFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", (event) => {
  if (!dragCarriesFiles(event)) return;
  fileDragDepth = Math.max(0, fileDragDepth - 1);
  if (fileDragDepth === 0) document.body.classList.remove("dragging-files");
});
function fileURLsFromTransfer(dataTransfer) {
  const raw = typeof dataTransfer?.getData === "function" ? dataTransfer.getData("text/uri-list") : "";
  const paths = [];
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const value = line.trim();
    if (!value.startsWith("file://")) continue;
    try {
      const path = decodeURIComponent(new URL(value).pathname);
      if (path.length > 0 && !paths.includes(path)) paths.push(path);
    } catch {
      // A malformed URI is ignored; it cannot address a file. 畸形 URI 直接忽略；它无法寻址文件。
    }
  }
  return paths;
}

window.addEventListener("drop", (event) => {
  if (!dragCarriesFiles(event)) return;
  event.preventDefault();
  fileDragDepth = 0;
  document.body.classList.remove("dragging-files");
  const dropped = Array.from(event.dataTransfer?.files ?? []);
  if (dropped.length > 0) {
    void addAttachmentFiles(dropped);
    return;
  }
  // Some platforms expose a file drop only as a URI list. Insert the paths so
  // the file is still addressable instead of dropping the gesture silently.
  // 某些平台只把文件拖放暴露为 URI 列表。插入路径，让文件仍然可寻址，而不是静默丢掉这次拖放。
  const paths = fileURLsFromTransfer(event.dataTransfer);
  if (paths.length > 0) {
    insertComposerText(paths.join("\n"));
    announce(`已拖入 ${paths.length} 个文件路径。`);
    $("query").focus();
  }
});
window.addEventListener("dragend", () => {
  fileDragDepth = 0;
  document.body.classList.remove("dragging-files");
});
// macOS may deliver candidate-confirming Enter just after compositionend.
// macOS 可能在 compositionend 之后才派发确认候选词的回车。
const IME_ENTER_GRACE_MS = 100;
let isComposing = false;
let lastCompositionEndAt = -Infinity;
$("query").addEventListener("compositionstart", () => { isComposing = true; });
$("query").addEventListener("compositionend", () => { isComposing = false; lastCompositionEndAt = Date.now(); });
$("query").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  if (isComposing || Date.now() - lastCompositionEndAt < IME_ENTER_GRACE_MS || event.isComposing || event.keyCode === 229) {
    event.preventDefault();
    return;
  }
  if (!event.shiftKey) { event.preventDefault(); $("request-form").requestSubmit(); }
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { setSidebarOpen(false); closeSchedules(); closeSettings(); } });
function updateScrollBottom() { const viewport = $("conversation"); const far = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 160; $("scroll-bottom").classList.toggle("visible", far); }
$("conversation").addEventListener("scroll", rememberCurrentScroll, { passive: true });
$("conversation").addEventListener("scroll", updateScrollBottom, { passive: true });
$("scroll-bottom").addEventListener("click", () => { const viewport = $("conversation"); viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" }); });
$("sidebar-resizer").addEventListener("pointerdown", (event) => { sidebarResizeActive = true; document.body.classList.add("sidebar-resizing"); event.currentTarget.setPointerCapture(event.pointerId); applySidebarWidth(event.clientX); });
$("sidebar-resizer").addEventListener("pointermove", (event) => { if (sidebarResizeActive) applySidebarWidth(event.clientX); });
$("sidebar-resizer").addEventListener("pointerup", (event) => { sidebarResizeActive = false; document.body.classList.remove("sidebar-resizing"); event.currentTarget.releasePointerCapture(event.pointerId); });
$("sidebar-resizer").addEventListener("keydown", (event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); const current = Number($("sidebar-resizer").getAttribute("aria-valuenow")); applySidebarWidth(current + (event.key === "ArrowRight" ? 16 : -16)); });
window.addEventListener("resize", () => applySidebarWidth(Number($("sidebar-resizer").getAttribute("aria-valuenow")), false));
restoreSidebarWidth();
window.closeSchedules = closeSchedules;
window.closeSettings = closeSettings;
window.openSchedules = openSchedules;
window.openSettings = openSettings;
window.openMobileBinding = openMobileBinding;
window.selectSettingsSection = selectSettingsSection;
window.setSidebarOpen = setSidebarOpen;
window.cloneMarkdownForPreview = richText;
notifyDesktopNavigation("ready");
if (location.protocol === "http:" || location.protocol === "https:") { void refresh({ preserveScroll: false }); state.refreshTimer = setInterval(() => { if (!document.hidden) void refresh(); }, 3000); }
