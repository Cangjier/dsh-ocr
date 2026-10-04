/**
 * Every `text_*` tool and action this plugin exposes, documented once.
 *
 * **This file is the single source of prose about the tool surface.** The resident JSON Schema
 * and the on-demand `text_guide` are both derived from it, so a description that says one thing
 * in a schema and another in the guide is impossible rather than merely unlikely. That matters
 * here more than usual, because the whole point of the plugin is that a coordinate you can
 * trust comes back with the text.
 *
 * Three rules shape what is written below:
 *
 * 1. **The resident schema carries only what choosing needs** — what the action produces, what
 *    it requires, the mistake it prevents, when it is the right call. Everything long (return
 *    shapes, cost, pitfalls, examples) is one `text_guide` call away and is not paid for on
 *    every turn.
 * 2. **A tool is a deterministic operation, never a pipeline.** Reading text and deciding what
 *    it means are separate acts; the second one belongs to DSH.
 * 3. **A capability this plugin does not have must say so.** Everywhere a vision model would
 *    do better, the entry names that rather than implying OCR replaces it.
 *
 * @module dsh-ocr/tools/registry
 */

/**
 * The tool surface, in the order it is presented.
 * @type {string[]}
 */
export const TOOL_ORDER = ['text_read', 'text_find', 'text_setup', 'text_guide']

/**
 * Tool and action documentation.
 *
 * `required` is repeated into the resident enum description, so it names only the arguments a
 * first call actually gets wrong.
 * @type {Record<string, {purpose: string, needs: string[], next: string[], actions: Record<string, object>}>}
 */
export const TOOLS = {
  text_read: {
    purpose:
      'Read the text on a picture — or on frames of a video — as data: every line with its content, ' +
      'its confidence, its pixel box, and the point that can be clicked. ' +
      'Use it when the exact characters matter, which is the one question a vision model answers unreliably.',
    needs: [
      'The path to an image or video that exists. Video and any cropping need ffmpeg, which is discovered automatically (this plugin\'s vendor/ffmpeg, a sibling video-factory install, DSH_OCR_FFMPEG, or PATH); a still image with no region needs neither ffmpeg nor ffprobe.',
      'An environment that can actually read text. Run `text_setup {action:"preflight"}` once before the first read of a session: it starts the engine and catches what a file listing cannot — a missing runtime DLL, a model set that did not unpack, a configured enginePath that no longer exists. Nothing installed at all: reads fall back to the Windows recogniser, which finds large labels but misreads small mixed-script text, and the result says so in `fault` and `notes`.',
    ],
    next: [
      '`text_find` when the question is where a string is rather than what the picture says.',
      '`text_guide {action:"rules"}` before acting on a coordinate.',
      '`text_setup {action:"preflight"}` first when OCR has not been run on this machine yet, or when a reading looked wrong.',
    ],
    actions: {
      read: {
        summary: 'read text off one or more images, or off frames of a video, with pixel coordinates',
        use: 'when the characters themselves matter — quoting a value, reading a filename, transcribing a label. For "what is in this picture" a vision model is the better tool and needs no setup.',
        avoid: 'a whole screen when you only care about one 11px label: the engine will shrink it out of legibility. Give `region`.',
        required: ['target or paths'],
        args: {
          target: 'an image or a video. A video is read at `frames` moments spread evenly through it unless `times` names exact seconds.',
          paths: 'up to 12 images in one call. Use it instead of `target` when reading a set of screenshots; the result is then keyed by file.',
          region: 'read only this part of the image: `{x,y,width,height}` or `"x,y,width,height"`, in source pixels. A small crop is both faster and more accurate.',
          scale: 'enlarge before recognising. `"auto"` (recommended with `region`) grows a small crop until its long side is about 1000px, at most 3x. A number is used as-is.',
          engine: '`auto` (default) uses the installed engine and falls back to Windows; `local` requires the installed engine and fails loudly without one; `winrt` uses Windows only, faster but wrong on small mixed-script text.',
          language: 'recognition language for the installed engine: `ch` (default), `cht`, `en`, `japan`, `korean`, `cyrillic`.',
          maxSideLen: 'long-side pixel limit handed to the engine. Lower is faster; default 1024.',
          minScore: 'confidence below which a line is left out of the joined `text` (default 0.5). `lines` always contains every line.',
          frames: 'for a video, how many frames to read, spread evenly. Default 4, at most 24.',
          times: 'for a video, the exact seconds to read instead of evenly spread frames. This is how subtitles are read back.',
          cwd: 'working directory that relative paths resolve against.',
        },
        returns:
          '{ok, path, kind, engine, elapsedMs, lineCount, dropped, text, lines[{text,score,x,y,width,height,box,center}], notes[], fault?}. ' +
          'A video result also carries {duration, frames[{at,engine,lineCount,text}]} and each line in `lines` carries the `at` it came from. ' +
          '`text` joins the lines that cleared minScore; `lines` is never filtered. ' +
          '`fault` appears when the answer came from a fallback recogniser because of an environment problem: {code, label, engine, executable, reason, hint}.',
        cost: 'one recognition per image. Measured here: 1.77s for a 1200x1013 screenshot on the default engine, about 0.2s for a small crop. The engine is a persistent child process — the first call pays a ~0.33s model load, later calls do not.',
        pitfalls: [
          'A line whose score is low is still returned in `lines` and still searchable: `text` is the filtered view, not the whole truth.',
          'On a video the times are spread through the whole clip, so the opening title card is not over-represented — but a subtitle that is only on screen for 0.4s can still be missed. Name the seconds with `times` when you know them.',
          '`engine: "local"` fails instead of degrading. That is deliberate: silently dropping to the Windows recogniser is how a wrong transcript becomes a confident one.',
          '`engine: "auto"` does degrade, but never silently: the result then carries `fault` and a leading note naming the environment problem. `engine` in the result is the one that answered — `winrt` means the characters are the weak kind, so do not quote them as the source text.',
          'Windows OCR returns no confidence score at all, so `score` is null and `minScore` cannot filter it.',
        ],
        example: { action: 'read', target: 'shot.png', region: '600,100,620,56', scale: 'auto', language: 'ch' },
        seeAlso: ['text_find', 'verify'],
      },
      verify: {
        summary: 'read burned-in subtitles back off a video and compare them with an SRT file',
        use: 'after delivering a video with burned subtitles, to check that the glyphs which were supposed to ship actually reached the screen and are legible. The times come from the SRT, so this is a measurement rather than an opinion.',
        avoid: 'asking whether the typography looks good — this reports similarity per cue, not taste.',
        required: ['target', 'srt'],
        args: {
          target: 'the delivered video.',
          srt: 'the subtitle file the expectations come from. Usually the one the plan named as `subtitles.source`.',
          sampleFrames: 'how many cues to read back. Default 6, spread evenly through the file, last cue always included.',
          leadSeconds: 'read this far into each cue. Default 0.35 — after the subtitle has appeared and before it starts to fade.',
          matchRatio: 'character similarity a cue must reach to count as correct. Default 0.6, which tolerates OCR noise but not a missing glyph.',
          language: 'recognition language. Default `ch`.',
        },
        returns:
          '{srt, engine, sampledCues, totalCues, cues[{at,expected,read,matched,matchedLine,similarity,ok}], failures[], minSimilarity, meanSimilarity, matchRatio}. ' +
          'Nothing to read is reported as {skipped: reason} rather than as a pass, and a failing engine as {error}.',
        cost: 'one frame extraction and one recognition per sampled cue — six by default. OCR is the slow part.',
        pitfalls: [
          'A cue is compared with the best single line the recogniser saw, and with adjacent line pairs, because a wrapped subtitle arrives as two lines and a screen full of interface text behind one subtitle would otherwise score near zero.',
          'Comparison strips punctuation, spacing and full-width/half-width differences: an OCR returns glyphs, not the SRT\'s commas.',
          'When OCR itself fails this returns empty cue and failure lists, which looks like a pass. Check `error` and `skipped`, not just the arrays.',
        ],
        example: { action: 'verify', target: 'out/final.mp4', srt: 'out/narration/voiceover.srt', sampleFrames: 8 },
        seeAlso: ['read'],
      },
    },
  },

  text_find: {
    purpose:
      'Locate text in an image or video frame and report where it is, as a pixel box and a clickable ' +
      'centre point. The inverse of `text_read`: give it the words, get back the position.',
    needs: [
      'The same engine and ffmpeg situation as `text_read` — Windows OCR as the zero-install fallback, an installed engine for small text.',
      'A reading that came from the installed engine when the position matters: check `engine` in the result, and `fault` when it is present. `text_setup {action:"preflight"}` answers that before the call.',
    ],
    next: [
      'Feed `best.center` to whatever clicks, or `matches[]` when several hits need deciding between.',
      '`text_read` when you want to see everything on the picture rather than one string.',
      '`text_setup {action:"preflight"}` when several searches are about to run, so an environment problem surfaces once instead of inside every miss.',
    ],
    actions: {
      find: {
        summary: 'find one or more strings in an image or video frame and return each match with its pixel box and centre point',
        use: 'to turn a label you can name into a coordinate you can act on: click a button, crop around a value, draw attention to a phrase.',
        avoid: 'searching a full screen for 11px text without a `region`: at full size the glyphs are too small to detect, and `scale: "auto"` only helps once the crop is small.',
        required: ['target', 'needle'],
        args: {
          target: 'the image or video to search.',
          needle: 'the text to look for, or an array of them. Case and spacing are ignored, including the spaces engines insert between CJK glyphs, so `音频` also matches `音 频`.',
          match: '`contains` (default) or `exact`. `exact` means the whole recognised line equals the needle, not that the needle is a prefix of it.',
          region: 'search only this part of the image: `{x,y,width,height}` or `"x,y,width,height"`.',
          scale: 'enlarge before recognising. `"auto"` with a `region` is the small-text recipe.',
          engine: '`auto` (default), `local` (installed engine only, fails loudly), or `winrt` (Windows only).',
          language: 'recognition language for the installed engine. Default `ch`.',
          maxSideLen: 'long-side pixel limit handed to the engine. Default 1024.',
          frames: 'for a video, how many frames to search, spread evenly. Default 4.',
          times: 'for a video, the exact seconds to search.',
          cwd: 'working directory that relative paths resolve against.',
        },
        returns:
          '{ok, target, engine, elapsedMs, needles, lineCount, matchCount, best, matches[{needle,lineIndex,text,score,x,y,width,height,center}], searched[], notes[], fault?}. ' +
          '`ok` is true only when something matched. A video result puts the frame time on each match as `at`. ' +
          '`fault` appears when a fallback recogniser answered because of an environment problem.',
        cost: 'one recognition pass, exactly like `read` — searching does not cost extra beyond it.',
        pitfalls: [
          'Matching sees every line the engine produced, including low-confidence ones: a 0.4-score line that says exactly what you asked for is a hit, not noise.',
          'No match is not proof the text is absent. Every line that was seen is returned in `searched`, so a miss can be told apart from a misread.',
          '`best` is the first match in reading order, not the most likely one. When several match, the decision is yours.',
        ],
        example: { action: 'find', target: 'shot.png', needle: ['始终安装', 'Install now'], region: '500,80,700,400', scale: 'auto' },
        seeAlso: ['text_read'],
      },
    },
  },

  text_setup: {
    purpose:
      'Provision and inspect the OCR engine: what is installed, which engine a call would use, whether it ' +
      'actually starts, what an install would download, and how to take it away again.',
    needs: [
      'The network and a few dozen megabytes for `install`. Reading a picture with the Windows recogniser needs neither.',
      'Nothing for `status` and `probe`, which inspect files only. `preflight` starts the engine once (about 0.3–0.5s cold) and leaves it warm.',
    ],
    next: [
      '`text_read` or `text_find` once an engine is installed.',
      '`preflight` before the first read of a session — it is the only check that catches an engine which is present but cannot run.',
      '`status` first whenever a reading looked wrong — it answers "which engine actually did that", without starting one.',
    ],
    actions: {
      status: {
        summary: 'report which OCR engine is installed, which one a call would use, and what the fallback is, without reading anything',
        use: 'before trusting a reading, and first whenever text came out wrong: it separates "the engine misread it" from "no engine is installed and Windows read it".',
        avoid: 'guessing at accuracy problems — this starts no engine and reads nothing, so it cannot itself be slow. It also cannot prove the engine runs: that is `preflight`.',
        required: [],
        args: {
          cwd: 'working directory that relative paths resolve against.',
        },
        returns:
          '{available, kind, label, executable, source, args, models{required,missing}, vendored{present,directory,engines[],files,sizeBytes}, configuredPath, prefer, winrtFallback, fault?, note?}. ' +
          '`source` says where the engine came from: `config`, `vendor`, or `path`. Without an engine, `available` is false and `fault` names why in the same shape `preflight` uses.',
        cost: 'file inspection only: no process is started, nothing is moved.',
        pitfalls: [
          '`available: true` with `kind: "winrt"` is impossible — WinRT is the fallback and is reported separately as `winrtFallback`.',
          '`available: true` means an engine *was found*, not that it works: a missing runtime DLL or a half-unpacked model set is invisible here. `preflight` is what starts it.',
        ],
        example: { action: 'status' },
        seeAlso: ['preflight', 'install', 'probe', 'text_read'],
      },
      probe: {
        summary: 'report whether ffmpeg and ffprobe were found, and where each one came from',
        use: 'when reading a video or a `region` fails in a way that might be ffmpeg rather than the engine. Reading a still image with no region needs neither, so a failure there is never ffmpeg.',
        avoid: 'installing ffmpeg through this plugin — it does not own one. It borrows: a sibling video-factory checkout\'s build is used automatically, and `text_setup {action:"install", ffmpeg:true}` is the way to ask for a private copy.',
        required: [],
        args: {
          cwd: 'working directory that relative paths resolve against.',
        },
        returns: '{ok, ffmpeg{path,source,version}|null, ffprobe{path,source,version}|null, notes[]}. `source` is one of config / env / vendor / sibling / path, so "it worked on my machine" stays explainable.',
        cost: 'two process spawns for the version lines.',
        pitfalls: [
          'A `sibling` source means the binary lives in another checkout. It works, but a machine that moves that checkout will lose it — set ffmpegPath or DSH_OCR_FFMPEG to make it explicit.',
        ],
        example: { action: 'probe' },
        seeAlso: ['status', 'preflight'],
      },
      preflight: {
        summary: 'start the OCR engine once and report whether this machine can read text right now, with a named fault for whatever stops it',
        use: 'before the first read of a session, and again after an install',
        avoid: 'running it before every read — it starts the engine, so it pays one cold start and leaves a warm process behind; `status` is the free version. It is also not a substitute for a real read: it proves the engine starts, not that any particular picture is legible.',
        required: [],
        args: {
          cwd: 'working directory that relative paths resolve against.',
        },
        returns:
          '{ok, verdict, platform{ok,name}, engine{available,kind,label,executable,source,models{required,missing},start{attempted,ok,elapsedMs,fault?}}|{available:false,fault}, fallback{winrt,script}, ffmpeg{ok,ffmpeg,ffprobe,notes}, checks[{id,ok,detail}], notes[]}. ' +
          '`verdict` is `ready` (an offline engine starts), `degraded` (only the Windows recogniser can answer) or `unusable` (nothing can). `ok` is false only for `unusable`.',
        cost: 'one engine start: about 0.33s for RapidOCR, 0.42s for PaddleOCR, then warm reuse. No image is read, so there is no recognition cost.',
        pitfalls: [
          'It catches what a file listing cannot: a missing runtime DLL, a model set that did not unpack, a configured enginePath that no longer exists, a CPU without the instruction set the engine needs.',
          '`verdict: "degraded"` still means text can be read — but by the Windows recogniser, which misreads small and mixed-script text. Do not quote such a reading as the source text.',
          'A passing preflight does not promise accuracy on a given screenshot: language, size and crop still decide that. It removes the environment as an explanation for a bad reading.',
          'The engine started here stays resident until it has been idle for the configured time; that is the point, but it is real memory.',
        ],
        example: { action: 'preflight' },
        seeAlso: ['status', 'install', 'text_read'],
      },
      install: {
        summary: 'download and unpack a pinned offline OCR engine into vendor/ocr/, verify it by SHA-256, and record it as active',
        use: 'when text on screen has to be read accurately and `status` reports no engine. The default engine is MIT-licensed and needs no AVX.',
        avoid: 'installing on a machine that only needs to find large labelled buttons — the Windows recogniser is already there, costs nothing, and is fast.',
        required: [],
        args: {
          source: '`rapidocr-json` (default): ONNX Runtime with PP-OCRv4, MIT, no AVX requirement, 1.77s for a 1200x1013 screenshot here. `paddleocr-ppocrv5`: a third-party Paddle Inference build with the newer models, slightly better on some small text and about nine times slower (15.9s on the same image), and it needs AVX.',
          prune: 'delete the recognition libraries for languages this plugin never asks for. Saves about 50MB and keeps Simplified Chinese, its dictionary, the detector and the classifier.',
          archive: 'use a local `.7z` instead of downloading. For a host where GitHub\'s CDN is throttled — the SHA-256 is still checked, so local never means unverified.',
          force: 'reinstall even when the engine is already present.',
          ffmpeg: 'also install a private copy of ffmpeg into this plugin\'s own vendor/ffmpeg, instead of borrowing the sibling video-factory build or PATH. Roughly 194MB.',
          onProgress: 'not a tool argument; the plugin logs progress while a 73MB download runs.',
        },
        returns:
          '{installed, source, directory, executable, pruned[], bytes, sha256, notes[]} on success, {installed:false, reason:"已安装", ...} when it was already there, and always the resulting state.',
        cost: '73.5MB down (RapidOCR) or 80.1MB (Paddle), then unpacking to about 95MB — 44MB after `prune`. Measured at 20KB/s on a throttled GitHub CDN during development, which is why `archive` exists.',
        pitfalls: [
          'A hash mismatch refuses the install outright. That is the point: the engine reads text out of your screenshots, so a truncated or substituted package must not become it.',
          'The 7-Zip reader (`7zr.exe`, 0.6MB) is fetched from 7-zip.org, a URL that always serves the current release. Its hash is recorded rather than enforced — a note appears in `notes` when upstream publishes a new one.',
          'Installing is idempotent: a second call with an engine present returns `installed: false` instead of downloading again.',
          'A successful unpack is not proof that the engine runs on this CPU — run `preflight` afterwards to find out.',
        ],
        example: { action: 'install', source: 'rapidocr-json', prune: true },
        seeAlso: ['preflight', 'status', 'remove'],
      },
      remove: {
        summary: 'delete an installed OCR engine from vendor/ocr/, or every engine and the unpacking tools with it',
        use: 'to reclaim the disk (about 44MB pruned, 95MB whole) or to reinstall cleanly from a different source.',
        avoid: 'removing an engine to "reset" a bad reading — `status` first; the problem is usually the region or the scale, not the install.',
        required: [],
        args: {
          source: 'which engine to remove: `rapidocr-json` or `paddleocr-ppocrv5`. Omit to remove every engine and the tools directory.',
        },
        returns: '{removed[], active} — what was actually deleted, and which source is active afterwards.',
        cost: 'file deletion only.',
        pitfalls: [
          'Removing the last engine is not a failure: reading still works through the Windows recogniser, just less accurately.',
        ],
        example: { action: 'remove', source: 'paddleocr-ppocrv5' },
        seeAlso: ['install', 'status', 'preflight'],
      },
    },
  },

  text_guide: {
    purpose:
      'The complete reference for this plugin, fetched on demand instead of sitting in every turn: ' +
      'argument-by-argument detail, return shapes, measured costs, pitfalls, examples, and the rules ' +
      'that decide which engine to trust.',
    needs: ['Nothing. It reads the same registry the tool schemas are built from, so it cannot disagree with them.'],
    next: ['Call the action it describes.'],
    actions: {
      overview: {
        summary: 'everything at once: the tool surface, the two engines, the cost table and the rules',
        use: 'once, at the start of a session that will do several OCR reads, so the later calls need no lookups.',
        avoid: 'fetching this before every single read — the resident schema already carries what one call needs.',
        required: [],
        args: { cwd: 'working directory that relative paths resolve against.' },
        returns: '{tools[], engines[], costs[], rules[], limits[]}.',
        cost: 'one call, no I/O.',
        example: { action: 'overview' },
        seeAlso: ['tool', 'action'],
      },
      tool: {
        summary: 'every action of one tool, in full: arguments, returns, cost, pitfalls, example, neighbours',
        use: 'when one tool is about to be used heavily and its resident enum line is not enough.',
        avoid: 'reading several tools one at a time when `overview` would have covered them together.',
        required: ['tool'],
        args: {
          tool: 'the tool name: `text_read`, `text_find`, `text_setup` or `text_guide`.',
          cwd: 'working directory that relative paths resolve against.',
        },
        returns: '{name, purpose, needs[], next[], actions{<action>:{summary,use,avoid,required,args,returns,cost,pitfalls,example,seeAlso}}}',
        cost: 'one call, no I/O.',
        example: { action: 'tool', tool: 'text_find' },
        seeAlso: ['action', 'overview'],
      },
      action: {
        summary: 'one action in full, with the tool it belongs to',
        use: 'when a single action is about to be called and its pitfalls decide whether the result is usable.',
        avoid: 'looking up `text_read read` before a first exploratory read — the schema is enough.',
        required: ['actionName'],
        args: {
          actionName:
            'the action to describe: `read`, `verify`, `find`, `status`, `probe`, `preflight`, `install`, `remove`, `overview`, `tool`, `rules`. It goes in this field, not in `action` — `action` selects this reference action.',
          tool: 'disambiguates when the same action name exists in two tools.',
          cwd: 'working directory that relative paths resolve against.',
        },
        returns: '{tool, action, ...the same entry as `tool`}.',
        cost: 'one call, no I/O.',
        example: { action: 'action', actionName: 'verify' },
        seeAlso: ['tool', 'overview'],
      },
      rules: {
        summary: 'the rules that decide trust: which engine answers, when coordinates are in source pixels, what OCR cannot do',
        use: 'before acting on a reading — especially before clicking a coordinate.',
        avoid: 'treating any of this as advice: each rule is a measured or mechanical consequence of the implementation.',
        required: [],
        args: { cwd: 'working directory that relative paths resolve against.' },
        returns: '{rules[{id, rule, why}]}',
        cost: 'one call, no I/O.',
        example: { action: 'rules' },
        seeAlso: ['overview'],
      },
    },
  },
}

/**
 * Look up one tool's registry entry.
 * @param {string} name - the tool name.
 * @returns {object|undefined} the entry.
 */
export function lookupTool(name) {
  return TOOLS[name]
}

/**
 * Look up one action's registry entry.
 * @param {string} tool - the tool name.
 * @param {string} action - the action name.
 * @returns {object|undefined} the entry.
 */
export function lookupAction(tool, action) {
  return TOOLS[tool]?.actions[action]
}
