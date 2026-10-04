# dsh-ocr

**像素里的文字，变成可用的数据。** 一个 DeepSeek Harness 插件：读出每一行的内容、置信度与像素框，或者反过来——给一段文字，返回它在图上的中心点（可直接点击）。

```
DSH 决定文字意味着什么  →  text_* 工具确定性地读出字符与坐标
```

**插件只报事实，不做判断。** 它不会说"这个读数够不够准"，不会描述画面内容，也不会替你点任何东西。它给的是 `text`、`score`、`x/y/width/height` 和 `center`——剩下的是你的。

- **为什么是独立插件**：识别文字需要引擎、引擎安装路径、一套自己的坐标空间（裁剪偏移 + 放大倍数要回算到调用者图像的像素系），还要能读视频帧。这些跟"把素材渲染成成片"一件都不相干。它从 `video-factory` 里搬出来了，两边**互不依赖**。- 工具清单与设计取舍：[docs/插件设计规格.md](docs/插件设计规格.md)
- 回归测试：`node --test "tests/*.test.mjs"`（68 个用例，其中 7 个需要已安装引擎）

---

## 工具

插件注册 **4 个工具、11 个 action**，分两层：**常驻 schema 只放"选择所需"**（做什么、必填什么、最易犯的错），**完整细节按需读** `text_guide`。同一份散文只有一个来源（`src/tools/registry.mjs`），schema 与 guide 都由它派生，**不可能互相矛盾**。

| 工具 | action | 做什么 |
| --- | --- | --- |
| `text_read` | `read` `verify` | **读图取字**（每行带像素框、置信度、中心点）；**字幕回读**：按 SRT 的时间点读画面上烧录的字幕，逐条算相似度 |
| `text_find` | `find` | **按文字找位置**：给一个或多个字符串，返回每一处的像素框与可点击中心点；没找到时把"看到过的每一行"一起返回 |
| `text_setup` | `status` `probe` `install` `remove` | 引擎状态、ffmpeg 发现情况、装/卸引擎（sha256 硬校验） |
| `text_guide` | `overview` `tool` `action` `rules` | **按需的完整能力目录**：参数、返回值、实测耗时、陷阱、示例，以及 12 条"信任规则" |

**边界写清楚**：`read` 报"这一行是什么字、在哪、多少分"，不报"这个读数能不能用"；`find` 的**没找到不等于不存在**——它把识别到的每一行都放在 `searched` 里，让你能区分"漏检"和"误读"；`verify` 报逐条相似度，不报"字幕排版好不好看"；`status` 只读文件系统，**不启动引擎**。本插件**不做云端 OCR**：视觉模型给不出逐行文字的像素框。

---

## 安装

```powershell
# 用插件管理器，spec 指向本仓库
#   plugin_manager install_bundle  target = <本仓库路径>
# 或手工：profile 的 package.json 加依赖与 bundle 行
#   "dsh-ocr": "link:C:/Users/you/Documents/GitHub/dsh-ocr"
```

装好后 `text_*` 工具**当场可用，不需要重启**。**修改插件源码后需要重启 DSH**：Node 按路径缓存 ES 模块，重新启用插件不会重新导入模块。

### 引擎（可选，但强烈建议装）

不装也能用——退回 Windows 自带的 `Windows.Media.Ocr`，**零安装但读不准小字**：实测它把 `TypeScript` 读成 `TvpeScript`、`自动化任务` 读成 `自 动 化 亻 壬 务`。装上引擎后同样一张图读对。

```
text_setup {action: "install", prune: true}     # 装默认引擎（RapidOCR / PP-OCRv4，MIT）
text_setup {action: "install"}                   # 再调一次：已装则跳过，不会重复下载
```

| 项 | 说明 |
| --- | --- |
| 引擎 | `rapidocr-json`（默认）：ONNX Runtime + PP-OCRv4 简中，**MIT**，不要求 AVX。下载 73.5 MB，解包约 95 MB，`prune: true` 后约 44 MB |
| 备选 | `paddleocr-ppocrv5`：第三方 Paddle Inference 构建 + PP-OCRv5，个别小字更准，但**同一张图实测慢约 9 倍**（15.9 s vs 1.77 s），且要求 AVX |
| 实测速度 | 整屏 1200x1013：**1.77 s / 35 行**，平均置信度 0.929；**只截一小块再放大：0.16–0.2 s**。所以找小字时给 `region` |
| 冷启动 | 模型加载 0.33 s（ONNX）/ 0.42 s（Paddle）。引擎是**常驻子进程**，之后每次识别不再付这笔钱 |
| 小字技巧 | `scale: "auto"` 把小图（或小 `region` 裁片）放大到长边约 1000px，最多 3 倍——11px 的字不放大基本读不出 |
| 校验 | 包按 **sha256 硬校验**后才解包；哈希不符直接拒绝安装，**不会**把半截下载当成引擎 |
| 空闲退出 | 引擎空闲 120 s 自动退出，释放约 500 MB；插件卸载时也会释放 |
| 网络慢 | `text_setup {action:"install", archive: "D:/下载/xxx.7z"}` 用本地包（sha256 照样校验）。实测 GitHub CDN 会把这次下载限到约 20 KB/s，所以留了这条路 |
| 解包工具 | 顺带取官方 `7zr.exe`（0.6 MB）放进 `vendor/ocr/tools/`。Windows 自带的 `tar.exe` 解不了 `.7z`（报 `LZMA codec is unsupported`） |
| 云端 | **不做**。视觉模型给不出逐行文字的像素框；要"看懂画面"请让 DSH 自己看图 |

### ffmpeg（可选，且通常不用自己装）

只有两件事需要 ffmpeg：**从视频抽帧**，以及**`region` 裁剪 / `scale` 放大**。读一张静态图、不给 `region`，**不需要 ffmpeg，也不需要 ffprobe**。

发现顺序：配置里的 `ffmpegPath` → 环境变量 `DSH_OCR_FFMPEG` / `DSH_OCR_FFPROBE` → 本插件 `vendor/ffmpeg/bin/` → **同目录 `video-factory` 的 `vendor/ffmpeg/bin/`** → `PATH`。

```
text_setup {action: "probe"}                     # 报 ffmpeg/ffprobe 在哪、来自哪一层
text_setup {action: "install", ffmpeg: true}     # 真要自己一份：装进本插件 vendor/（约 194 MB）
```

`probe` 会明确说 `source` 是 `config` / `env` / `vendor` / `sibling` / `path` 里的哪一个——**"在我这能用"必须可解释**。借来的（`sibling`）能用，但那份检出被移走就失效，所以 `probe` 会就此给一条提示。

---

## 怎么用

### 读文字

```
text_read {action: "read", target: "截图.png"}
```

```jsonc
{
  "ok": true,
  "kind": "image",
  "engine": "rapidocr-json",
  "elapsedMs": 676,
  "lineCount": 2,
  "text": "自动化任务\nTypeScript 解析",          // 只含 score ≥ minScore 的行
  "lines": [                                       // 永远不过滤，低分行也在
    { "text": "自动化任务", "score": 0.9993,
      "x": 63, "y": 60, "width": 216, "height": 47,
      "box": [[63,60],[279,60],[279,107],[63,107]],
      "center": { "x": 171, "y": 84 } },
    { "text": "TypeScript 解析", "score": 0.9705, "x": 59, "y": 177, "width": 162, "height": 29, … }
  ],
  "dropped": 0,
  "notes": []
}
```

- **`lines` 不过滤是刻意的**：0.4 分的行如果正好是你要找的那句话，它就是命中，不是噪声。`text` 是过滤视图，`lines` 是全部真相。
- **坐标永远在"你给的那个文件"的像素系里**。插件内部会裁剪、会放大，但回报的框已经把这些换算回去了——所以"读字"和"点这个标签"用的是同一套数字。
- 一次最多 12 个文件（`paths`），一个视频最多读 24 帧（`frames`），也可以指定确切秒数（`times`）。

### 定位文字

```
text_find {action: "find", target: "截图.png", needle: ["始终安装", "Install now"]}
```

```jsonc
{
  "ok": true,
  "matchCount": 1,
  "best": { "text": "始终安装", "score": 0.9912,
            "x": 620, "y": 104, "width": 96, "height": 28,
            "center": { "x": 668, "y": 118 } },     // ← 可直接点的中心点
  "matches": [ … ],
  "searched": ["文件", "编辑", "始终安装", …]        // ← 没找到时靠它区分"漏检"与"误读"
}
```

匹配**忽略大小写与空白**，包括引擎在 CJK 字之间插入的空格，所以 `音频` 也能匹配到 `音 频`。`text_find` 搜索**每一行**，包括低分行——`minScore` 在这里不生效，这是刻意的。

### 回读烧录字幕

```
text_read {action: "verify", target: "out/final.mp4", srt: "out/narration/voiceover.srt"}
```

按 SRT 自己的时间点（`cue.start + leadSeconds`）抽帧、识别，然后**逐条算字符级相似度**：

```jsonc
{
  "ok": true,
  "sampledCues": 6,
  "totalCues": 24,
  "cues": [
    { "at": 1.35, "expected": "给它最小的权限，", "read": "给它最小的权限",
      "matched": "给它最小的权限", "matchedLine": "line", "similarity": 1, "ok": true }
  ],
  "failures": [],
  "minSimilarity": 0.941,
  "meanSimilarity": 0.982,
  "matchRatio": 0.6
}
```

两个细节让它真的在测量而不是在走过场：

1. **和"最好的一行"比，不和整帧比。** 教程视频里字幕背后常有一屏界面文字，拿整帧去比会得 0.03 分——那时量的是视频的其它内容，不是字幕。相邻两行**成对**也是候选，因为换行的字幕本来就分两行。
2. **比对前先归一化**：全角转半角、去标点空白，再按字符算最长公共子序列占比。OCR 读回的是**字形**，不是 SRT 里的逗号。

**什么都测不了时报 `{skipped: 原因}`，引擎挂了报 `{error}`——都不是"通过"。** 空数组最像通过，也最容易骗过粗糙的调用方。

### 引擎与环境

```
text_setup {action: "status"}    # 装了哪个、会走哪个、WinRT 回退在不在（不启动引擎，零成本）
text_setup {action: "probe"}     # ffmpeg/ffprobe 在哪、来自哪一层
text_setup {action: "remove"}    # 删掉所有引擎与解包工具，回收约 44 MB
```

---

## 信任规则（`text_guide {action:"rules"}` 节选）

| 规则 | 为什么 |
| --- | --- |
| 显式配置 > `vendor/ocr/`（以清单记录的为准）> `PATH`，`status` 会说是哪一个答的 | 装了两个引擎时，选择不能取决于目录顺序；说不出来源的读数没法排查 |
| 框与中心点永远在**你给的文件**的坐标系里 | 裁剪偏移是加、放大倍数是除，顺序错了就是"字读对了但点错地方" |
| `lines` 不过滤，`text` 按 `minScore`（默认 0.5）过滤；`find` 搜索所有行 | 低分行正好是要找的那句话时，它就是命中 |
| `engine: "local"` 没引擎就**报错**，`auto` 才降级，且降级会写进 `notes` | 静默降级会把"错的转写"变成"自信的转写" |
| WinRT 没有置信度：`score` 是 `null`，`minScore` 对它无效 | 没有东西可设阈值，`null` 意思是"未知"，不是"满分" |
| 20px 以下的字给 `region` + `scale: "auto"` | 引擎会把整屏缩到长边上限，小字在那一步就没了 |
| 视频默认在整片**均匀**取 4 帧，不是从开头取 | 录屏开头常是标题卡；而 0.4 秒的字幕用均匀取帧会漏 |
| `find` 没找到不等于不存在，`searched` 是区分依据 | 两者的修法不同：一个是裁剪，一个是语言或引擎设置 |
| 只报字符与坐标，不描述画面、不判断好坏、不点击 | "这是什么画面"视觉模型答得更好且零安装；OCR 的价值在**确切的字符**和**坐标** |

完整 12 条：`text_guide {action: "rules"}`。

---

## 用命令行

同一批操作也暴露成 CLI，便于调试和跑测试：

```powershell
node src/bin/ocr.mjs doctor                                        # 引擎 + ffmpeg 体检
node src/bin/ocr.mjs engines                                       # 只报引擎状态
node src/bin/ocr.mjs setup --prune                                 # 装默认引擎
node src/bin/ocr.mjs read 截图.png                                  # 读全部文字
node src/bin/ocr.mjs read 截图.png --region 600,100,620,56 --scale auto
node src/bin/ocr.mjs read 截图.png --find "始终安装"                  # 读并定位
node src/bin/ocr.mjs find 截图.png --needle "始终安装" --json         # 只定位，给坐标
node src/bin/ocr.mjs read out/final.mp4 --frames 6 --json           # 读视频帧
```

## 端到端验证

```powershell
node --test "tests/*.test.mjs"
```

68 个用例，其中 7 个需要已装引擎（没装则**干净跳过**，不伪装成通过）。引擎那 7 个不是断言文档，而是拿现渲染出来的图去证实五件事：小字中英混排能读对、裁剪放大后的框落回原图正确位置、视频逐帧各留各的结果、工具层返回的 `center` 真的能点、`region` 不会污染字幕回读。

---

## 架构

```
index.mjs              插件入口：apply / inject / 工具注册 / 配置校验
src/tools/*.mjs        工具 schema 与 action 实现（唯一知道 DSH 存在的层）
src/core/*.mjs         确定性内核：纯 ESM、零第三方依赖、可离线单测
src/bin/ocr.mjs        命令行入口
src/bin/ocr.ps1        WinRT 回退的包装（PowerShell 5.1 不能直接 await WinRT）
vendor/ocr/            离线 OCR 引擎（可选；没装就走 Windows 自带识别）
vendor/ffmpeg/         私有 ffmpeg（可选；通常借用同目录 video-factory 的那份）
```

内核文件与职责：

| 文件 | 做什么 |
| --- | --- |
| `core/engine.mjs` | 引擎发现（配置 → vendor → PATH）、常驻会话协议、结果归一化、**坐标回算**、裁剪放大、图片/视频读取、WinRT 回退 |
| `core/install.mjs` | 引擎清单、sha256 校验、7-Zip 解包、`prune`、装/卸 |
| `core/subtitles.mjs` | SRT 解析、文本归一化、相似度、按时间点回读比对 |
| `core/probe.mjs` | 只需要两个答案：图多大、视频多长 |
| `core/ffmpeg.mjs` | 跑 ffmpeg/ffprobe，参数永远是数组，`-nostdin` 与 `-y` 永远一起给 |
| `core/net.mjs` + `core/proxy.mjs` | 下载与哈希；**自己读注册表代理**并手写 CONNECT 隧道 |
| `core/env.mjs` | 插件根目录、二进制发现、CJK 字体 |

**内核不依赖 DSH**，所以"确定性"可离线证明。

---

## 踩过的坑（都已在实现中修正）

| 坑 | 表现 | 处理 |
| --- | --- | --- |
| **OCR 坐标乘错方向** | 放大图的框要**除以**倍数、**再加**裁剪偏移；反了就是平方级偏移，点击落到别处，而文字**读得完全正确** | 换算只在一处（`normaliseEngineResult`），单测覆盖"旋转框 + 偏移 + 缩放"的组合 |
| **CJK 的框只取首个词** | WinRT 把中文拆成一字一词（`开 始 演 示` 是六个词），只取首词宽度约 62px，中心点偏到标签左边，点不中一个**明明定位对了**的按钮 | 逐词并集求整个行的包围盒 |
| **WinRT 类型必须写成带 ContentType 的字面量** | `[Type]::GetType('...')` 返回 CLR 影子类型，用影子类型建的实例被引擎拒绝，报的是莫名其妙的一句"cannot convert Windows.Globalization.Language to Windows.Globalization.Language" | 一律用 `[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]` 形式 |
| **PowerShell 5.1 的控制台编码** | 识别出的中文到 Node 父进程变乱码，**结果是对的但每个查找都静默失败** | 出口强制 `UTF8Encoding(false)` |
| **引擎的 JSON 解析器怕非 ASCII 路径** | 中文路径在部分代码页下变乱码 | stdin 送 `\uXXXX` 转义过的纯 ASCII JSON（`asciiJson`） |
| **常驻引擎拖住进程** | 短命脚本会等 120 s 空闲计时器才退出 | 会话可显式释放（`disposeOcrSessions`），测试与 CLI 都调用；计时器 `unref()` |
| **引擎初始化无回音** | 参数或模型文件错了，进程死得无声无息 | 等 `OCR init completed` 横幅，60 s 无消息即判失败，并把 stderr 尾部一并报出 |
| **Windows 没有能解 `.7z` 的工具** | `tar.exe` 报 `LZMA codec is unsupported`，7-Zip 通常没装 | 安装器顺带取官方 `7zr.exe`（0.6 MB）；它的哈希**只记录不强制**，因为那个 URL 永远指向最新版 |
| **`7zr.exe` 的哈希不能强制** | 上游发新版就会让安装器彻底不能装——这比"记录到一条哈希变化"更糟 | 校验失败但不中止，把差异写进 `notes` |
| **系统代理对 Node 不可见** | 从插件里下载报 `fetch failed`，同一个 URL 在 PowerShell 里 1.4 秒就取到。Node 的 `fetch` 既不读 Windows 注册表代理，也不认 `HTTPS_PROXY`（Node 24 实测：设了变量、加了 `NODE_USE_ENV_PROXY=1`，仍然直连超时） | 自己读注册表 `ProxyEnable`/`ProxyServer`，用 `http CONNECT` + `tls` 建隧道；`undici` 在 Node 24 里**不可导入**，只能用内置模块手写 |
| **代理下漏掉重定向** | GitHub 的 `/releases/download/` 返回 302 跳 CDN。不跟重定向就会把 200 字节的 "Found" 页面当成引擎包去校验哈希 | 跟随重定向（上限 8 跳），每跳后排空响应体 |
| **`ffprobe` 不接受 `-y`** | `Failed to set value '-y' for option 'nostdin'` | ffmpeg 与 ffprobe 用不同的前缀（`-nostdin -y` vs 无） |
| **`-nostdin` 不加 `-y` 会卡在确认提示** | 重跑时 ffmpeg 要交互确认，退出码 1，stderr 只有一行 `Duration:` | 两者总是一起加 |
| **字幕整帧比对几乎全是误报** | 教程视频字幕背后有一屏界面文字，拿整帧比只得 0.03 分，而字幕其实完美可读 | 和"最好的一行"比，相邻两行成对也在候选里 |
| **工作目录不该是插件源码** | 裁剪件与抽帧写进插件目录，`link:` 安装下可能不可写，也污染版本控制 | 临时件写系统临时目录，用完即删 |

---

## 许可与来源

本插件自身 **MIT**。它**不分发**任何引擎，只在用户执行 `text_setup {action:"install"}` 时按**钉死的 release URL + sha256** 下载：

| 组件 | 许可 | 来源 |
| --- | --- | --- |
| RapidOCR-json v0.2.0 | MIT | [hiroi-sora/RapidOCR-json](https://github.com/hiroi-sora/RapidOCR-json/releases/tag/v0.2.0) |
| PaddleOCR-json + PP-OCRv5 mobile | 构建者未声明；模型来自 PaddleOCR（Apache-2.0） | [OneDongua/PaddleOCR-json_PP-OCRv5_umi_plugin](https://github.com/OneDongua/PaddleOCR-json_PP-OCRv5_umi_plugin/releases/tag/v1.0) |
| `7zr.exe` | LGPL / BSD-3-Clause | [7-zip.org](https://www.7-zip.org/a/7zr.exe) |

清单里记录的 sha256 是**首次落盘时的完整性锚点**，用于防篡改与复现，**不构成来源合法性证明**；备选引擎的构建者没有声明许可，商用前请自行核对。

`text_setup {action:"install"}` 的每一步都可审计：下载了什么 URL、字节数多少、sha256 是多少、prune 删了哪些文件，都写进 `vendor/ocr/SOURCE.json`。
