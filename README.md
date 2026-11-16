# dsh-dsml-guard

> 专治 DSML 泄漏：把模型漏进正文的标记抹掉，并在「这一轮其实什么都没产出」或「上游临时失败」时自动补一条 **继续**。
> 只在**发「继续」能真正解决**时续跑（单次回复 token 到顶、空响应/流中断/5xx、被误分类成坏请求的网络抖动）；
> 余额、额度、鉴权、上下文总体超限这类发继续只会再报错的，一律不动。默认连续 3 次失败后停发。
> 与 DSH 自带「重试策略」重叠的四个码默认交给宿主重试，插件不重复打（见「与 DSH 自带重试策略的分工」）。

**当前版本：0.1.4**（2026-11-17）。已发布到 npm（`dsh-dsml-guard@0.1.4`）与 GitHub（`v0.1.4` tag）。
插件市场（awesome-dsh-plugin / dshmarket）收录的是仓库 URL、版本从 npm 自动刷新，无需在条目里写版本号。

## 为什么需要它

本机实测（2026-10-28，扫 245 个 v4 会话 / 1.5 GB 文本）：

| 事实 | 读数 |
| --- | --- |
| 真实泄漏 | 28 次，全部来自 `deepseek-v4.1-flash` 第三方直连（beichen 18 / beichen-ds 9 / aiaaa 1） |
| 泄漏那一轮的 `turn/end` | **一律 `{"kind":"completed"}`** —— 宿主认为正常结束 |
| `invoke-block` 形态（整段调用写进正文） | 12 次，泄漏前正文中位数 **1 个字符**，同消息 tool-call 块 **0 个** |
| `tail-close` 形态（只有结尾闭合标签） | 17 次，泄漏前正文中位数 **755 字符**，答案是完整的 |

两条直接推论：

1. 市场里的 `dsh-auto-continue` **永远触发不了这种情况** —— 它只认 `kind === 'error'` 且错误码在白名单里，而这里是 `completed`。
2. 市面上唯一那个清洗插件（`@goodandready/dsh-dsml-artifact-guard`）的正则写死**单竖线** `｜DSML｜`，
   而真实流量是**双竖线** `｜｜DSML｜｜`。实测：双竖线样本 38/38、62/62、44/44 字符**原样放行**，
   只有单竖线样本被清（69 → 15）。所以它对本机这条链路等于没装。

## 它做什么

**① 清洗**（`llm/stream` 钩子，只改显示，不动请求）

认三种竖线写法：`｜｜DSML｜｜`（实测主流）、`｜DSML｜`、`||DSML||`。处理四种残渣：

- 完整 `invoke` / `tool_calls` 块 → **整块摘掉**（按标签深度配对，不是贪婪正则）；
- 结尾连缀的闭合标签 → 摘掉；
- 孤立的外层包裹残片 `<｜｜DSML｜｜ calls>` → 摘掉；
- 光头标记 `<｜｜DSML｜｜>`（后面没有标签名）→ 摘掉。

**代码围栏 ``` 与行内 `code` 里一律不动** —— 那是人在讨论语法，删了才是坏事。

**清洗作用于「落历史的那条路径」，不只是屏幕。** 这一点是承重的：

- 适配器在 `finish` 前发 `block-end`，它携带的是**完整 block 全文**；
- 真实存档实证（2026-10-29）：4/4 条脏消息的落盘正文与 `block-end.text` **逐字节相等**，
  与 `text-delta` 拼接**不相等**；
- 所以只在 `text-delta` 上清洗 = 屏幕干净、历史仍脏 → 下一轮又把标记喂回上游。
  插件在 `block-end` 上把文本块替换成「实际发出去的内容」，让 **历史 = 屏幕**。

这条就是「上下文污染」的断点：**新会话从第一轮起，历史里不会再留下标记。**

### 关于「越漏越多」：本机数据不支持这个假设

2026-10-29 在 245 个会话 / 1.5 GB 文本上量过：

| 量测 | 读数 |
| --- | --- |
| 同一会话前半段 vs 后半段泄漏率 | 0.2% → 0.3%（几乎无差别） |
| 此前已漏 0 次 → 下一轮再漏 | 11/7855 = **0.1%** |
| 此前已漏 1 次 → 下一轮再漏 | 4/4356 = **0.1%** |
| 此前已漏 2 次 → 下一轮再漏 | 4/91 = 4.4%（样本仅 91，不足以支撑） |
| 输入 token 200k 以上 | 泄漏 0/428 = **0%**（泄漏全集中在 0–50k：27/71872） |

也就是说：**泄漏率不随会话长度上升，也不随历史泄漏次数上升**。它更像一次独立的上游行为
抖动（上游偶尔漏写 `<｜DSML｜｜ tool_calls>` 包裹，vLLM 侧 [#55954](https://github.com/vllm-project/vllm/pull/55954)
已修、Rust 前端 [#58057](https://github.com/vllm-project/vllm/pull/58057) 仍未修）。

**但「污染」这件事在机制上真实存在** —— 不是因为泄漏率会升高，而是因为脏标记一旦落进历史，
就会每轮被重新发给上游，模型看到「我过去的思考里全是标记」这个形状，本机实测出现过它
把工作笔记写成正文（#147 那类）。`block-end` 清洗从源头堵住了这个路径。

### 存量脏历史（29 条 / 29,442 字符）

插件只对**新产生的**回合生效。已有存档里仍有 29 条脏消息（分布在 11 个会话，最大一条 18,395 字符）。
它们不影响新会话，但**如果你继续用那几个旧会话，脏历史还会被发出去**。三种处置：

1. **最省事**：在旧会话里跑一次 `/compact`，压缩会把脏段落折叠成摘要（摘要由模型写，不带标记）；
2. **手动**：新建会话接着干活，旧会话只作查阅；
3. **批量清洗存档**：写个脚本解码 v4 存档、就地重写那几条脏消息 —— 但那是改历史，
   需要单独确认后再做（本插件当前**不**提供这个动作）。


**② 续跑**（`session/event` 的 `turn/end`，通过 `agent.followup()` 补消息）

只在这几种情况下补「继续」：

- `invoke-block` 泄漏 **且** 这一轮没有发出过任何 `tool-call-delta` → 调用确实丢了，一轮没产出；
- `tail-close` 泄漏 **且** 正文短于 `tailCloseMinChars`（默认 80 字符）→ 视为没产出；
- `turn/end.reason.kind === 'max-tokens'`：**单次回复输出 token 到顶**（不是上下文超限），继续能接着写；
- `turn/end` 错误码属于可重试集：`TIMEOUT` / `TRANSPORT` / `SERVER` / `MALFORMED_RESPONSE` /
  `PI_AI_ERROR` / `UNKNOWN` / `EMPTY_RESPONSE` / `STREAM_CLOSED` / `NETWORK_ERROR`；
- 兜底码（`INVALID_REQUEST` / `CLIENT_ERROR` / `PI_AI_ERROR` / `UNKNOWN` 等）**报文**里是
  `i/o timeout` / `read tcp` / `stream interrupted` 这类本机/上游网络波动时，按报文推翻顶层分类续跑
  （本机实测大量 `INVALID_REQUEST` 其实是 `read tcp … i/o timeout`）。

**不续跑**（发继续也会照样报错，浪费一次往返）：

`QUOTA`、`QUOTA_EXCEEDED`、`ACCOUNT_QUOTA`、`RATE_LIMIT`、`AUTH`、`MISSING_CREDENTIAL`、
`CONTEXT_WINDOW_EXCEEDED`、`UNKNOWN_MODEL`、`HTTP_413`、`CLIENT_ERROR`、`INVALID_REQUEST`；
以及 `aborted` / `interrupted`（用户自己按了停，不该替他续）。
兜底码报文里是「未配置凭据 / 请先登录 / 无此模型 / 余额不足」时按报文否决。
明确永久码（额度/鉴权/上下文/体积）按码否决、信任码本身，不被报文里的网络措辞带偏。

还有两道闸：

- **同一会话连续续跑上限** `maxConsecutive`（默认 **3**，夹在 1–100）：连续 3 次「失败 → 继续」后不再发；
  **中间只要有一次正常回复就清零重算**（`失败-继续-正常回复-失败-继续-失败-继续-失败` 到这里只算 2 次，仍会继续发）。
  不续跑的永久错误不算正常回复、不打断连续链，计数保持不变；
- **用户一说话就清空**：你手动发消息会取消待发的续跑并把计数归零（插件自己补的那条不算干预）。

## 适用版本

| 项 | 要求 | 说明 |
| --- | --- | --- |
| DeepSeek Harness | **`>=0.2.1-rc.2 <0.3.0`** | 实测于 `0.2.1-rc.3`（Windows，Electron 桌面端）。用到的两个钩子 `llm/stream`、`session/event` 与 `agent.followup()` 均在该区间内的宿主上存在。 |
| Node.js | **`>=20`** | 只在用了 `crypto.randomUUID()`、`AsyncIterator` 这类标准 API，没有原生依赖。 |
| 运行平台 | **不限** | 纯宿主插件，无浏览器端代码、无二进制、无构建脚本。 |
| 模型 | **不限**，但问题主要出现在第三方直连的 `deepseek-v4.1-flash` | 本机 28 次泄漏全部来自这条链路；官方通道未观察到。 |

> `0.2.0` 及更早的宿主没有实测过，`engines.dsh` 因此从 `0.2.1-rc.2` 起算。
> 装到范围外的宿主上，DSH 会在安装时按 `engines` 直接拒绝。

## 安装

**给别人装，就这一条**（从 npm 装，无需构建授权、无需本地编译）：

```sh
dsh plugin --profile <你的 profile> add dsh-dsml-guard
```

当前 npm 最新版是 **0.1.3**。想锁死版本、避免以后自动漂移，写成 `dsh-dsml-guard@0.1.3`。

`--profile` 填对方实际在用的那个：
**桌面应用用 `desktop`**，自启的 `dsh web` 服务用 `web`。填错 profile 等于没装 —— 重启多少次都不会加载。

装完**重启 DSH**。

不用 npm 也可以直接从 GitHub 装（锁 tag，内容不会漂移）：

```sh
dsh plugin --profile <profile> add https://github.com/Jessicaisleep/dsh-dsml-guard/archive/refs/tags/v0.1.3.tar.gz
```

> 用 GitHub 源装会在对方机器上跑构建脚本（本包没有构建步骤，只是 pnpm 的常规授权流程），
> 且 `github:owner/repo` 这种简写会被解析成 SSH 地址而匿名被拒，所以上面写的是完整 tar.gz 地址。

改源码时用本地路径装（每次改动后要重新 `add` 一次才生效）：

```powershell
dsh plugin --profile desktop add "file:E:\DSHWORK\DSH插件\dsh-dsml-guard"
```

然后重启 DSH。配置文件 `profiles/desktop/cordis.patch.yml` 里出现下面这段即视为加载：

```yaml
- id: dsml-guard
  name: dsh-dsml-guard
```

想确认真的挂上了，可以看这一行有没有进宿主配置：

```powershell
dsh --profile web --dump-config | Select-String "dsml-guard"
```

（`desktop` profile 由 Electron 独占，`--dump-config` 会被拒绝，这是正常的。）

## 发版（Git 工作流，不走本地 npm token）

发布由 GitHub Actions 用 **npm Trusted Publishing（OIDC）** 完成，本地不需要任何 npm token，也就不会再被 2FA 挡住。
推一个 `v*` tag 就发一版；普通提交只触发 `ci.yml`（Node 20/22/24 三档跑测试 + `npm pack --dry-run`），**不会发版**。

`publish.yml` 在 tag 推送后自动执行：语法检查 → 42 条单元测试 → 校验 tag 与 `package.json` 版本一致 → `npm publish`。

**常规流程**（版本号交给 npm 改 + 打 tag，一次到位）：

```sh
npm version patch        # 或 minor / major：改 package.json 并打一个 vX.Y.Z tag
git push --follow-tags   # 推提交 + 推 tag，触发 publish.yml
```

三个踩过的坑，照着避：

1. **tag 必须和 `package.json` 的 `version` 逐字一致**。`publish.yml` 里有一步
   `Verify tag matches package version`，不一致直接 `::error::tag v$TAG does not match package.json version $VER` 退出。
2. **如果已经手工把 `package.json` 改成了目标版本号，就不要再跑 `npm version patch`** —— 它会再 +1（0.1.3 → 0.1.4），
   和 tag 对不上。这种情况直接 `git tag -a v0.1.3 -m "release 0.1.3"` 然后推 tag 即可。
3. **本机 `github.com:443` 时段性连不上**（SSH 又没配密钥）。推不上去时不用硬扛：
   `api.github.com` 一直通，可以用它的 **Git Data API**（造 blob/tree/commit/tag 对象，再 `PATCH /git/refs/heads/main`、
   `POST /git/refs` 建 tag ref）把提交和 tag 直接推上去，完全绕开 `github.com:443`。
   注意造对象时内容要取自 `git cat-file blob <sha>`（保证 CRLF/BOM 与本地对象库一致），
   commit/tag 的 message 要带尾随换行，否则远端 sha 和本地对不上。
   工作区里的 `E:\DSHWORK\github-helper\README.md` 有这套通道的说明与脚本。

### 一次性配置（已经做过，换电脑或换仓库才需要重来）

在 npmjs.com → 该 package → **Settings → Trusted Publisher → GitHub Actions** 填：

| 字段 | 值 |
| --- | --- |
| Organization or user | `Jessicaisleep` |
| Repository | `dsh-dsml-guard` |
| Workflow filename | `publish.yml` |
| Environment | 留空 |

> 配好之后，本地 `pnpm publish` 就不再需要了；也建议到 npm 上**吊销**之前那个 `npm_` token（它现在没用了，留着只是多一个可被滥用的凭据）。

## 更新日志

| 版本 | 日期 | 内容 |
| --- | --- | --- |
| 0.1.0 | 2026-10-28 | 初版：DSML 标记清洗（`text-delta`）+ 证据门控的自动续跑 |
| 0.1.1 | 2026-10-29 | 补上 `block-end` 清洗，让「历史 = 屏幕」；加 `ci.yml` / `publish.yml`（OIDC 发版）与 `test/history.mjs` |
| 0.1.2 | 2026-10-29 | 纯发版（package.json 版本号推进），代码与 0.1.1 相同 |
| **0.1.3** | **2026-11-12** | 连续续跑上限 5→**3**、正常回复/`reason` 为空的正常完成轮清零；新增 `max-tokens` 续跑；可重试集补 `EMPTY_RESPONSE/STREAM_CLOSED/NETWORK_ERROR`；对 `INVALID_REQUEST/CLIENT_ERROR/PI_AI_ERROR/UNKNOWN` 做报文级细分（本机/上游网络波动续、永久配置错误否）；`decideSend` 纯函数化并加端到端用例（单测总数扩到 35 条） |

| **0.1.4** | **2026-11-17** | 新增 `skipHostRetriedCodes`（默认 `true`）：与 DSH ≥0.2.2 模型设置页「重试策略」（`@deepseek-ai/dsh-llm-retry`，默认「仅临时错误」）重叠的 `EMPTY_RESPONSE/SERVER/TIMEOUT/TRANSPORT` 交给宿主在 step 内退避重试，插件不再叠加一条「继续」；置 `false` 恢复 0.1.3 的兜底。清洗与 `max-tokens`/泄漏续跑不受影响（真实会话回放 28 条、残留 0 条、判续 18 条，与 0.1.3 一致）。单测 35→42 |

> `0.1.3` 的完整判定依据见下方「与同类插件的覆盖对比」；`0.1.4` 的分工见「与 DSH 自带重试策略的分工」。

## 配置（可选）

```yaml
- id: dsml-guard
  name: dsh-dsml-guard
  config:
    enabled: true            # 总开关
    sanitize: true           # 抹标记
    autoContinue: true       # 自动补「继续」
    continueText: "继续"
    maxConsecutive: 3        # 连续续跑上限（默认 3，正常回复清零）
    tailCloseMinChars: 80    # tail-close 形态下，正文短于这个才续跑
    skipHostRetriedCodes: true   # 与 DSH「重试策略」重叠的四个码交给宿主，不重复续跑（见下节）
    retryCodes: [TIMEOUT, TRANSPORT, SERVER, MALFORMED_RESPONSE, PI_AI_ERROR, UNKNOWN,
                 EMPTY_RESPONSE, STREAM_CLOSED, NETWORK_ERROR]
    neverCodes: [QUOTA, QUOTA_EXCEEDED, ACCOUNT_QUOTA, RATE_LIMIT, AUTH,
                 MISSING_CREDENTIAL, CONTEXT_WINDOW_EXCEEDED, UNKNOWN_MODEL,
                 HTTP_413, CLIENT_ERROR, INVALID_REQUEST]
```

## 与 DSH 自带重试策略的分工（0.1.4）

DSH 0.2.2 起，模型设置页每个 API 下多了**「重试策略」**（默认「仅临时错误」）。执行器是
`@deepseek-ai/dsh-llm-retry`，挂在 `agent/request-error` 上，**在同一个 step 内**重跑失败的请求：
默认 5 次、500ms→10s 指数退避、±10% 抖动，可重试集
`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`。它不新开 turn、不追加 user 消息，
失败的那段部分输出直接丢弃（不进历史、不进上下文）。

两者层次不同（宿主在 step 内重发同一请求，本插件在 turn 结束后补一条「继续」），但错误码上有四个重叠。
0.1.4 起**默认把重叠面交给宿主**，插件不再对同一份请求再打一轮：

| 错误码 / 场景 | 谁处理（默认） |
| --- | --- |
| `EMPTY_RESPONSE` `SERVER` `TIMEOUT` `TRANSPORT` | 宿主 `llm-retry`（插件跳过） |
| `MALFORMED_RESPONSE` `PI_AI_ERROR` `UNKNOWN` `STREAM_CLOSED` `NETWORK_ERROR`、以及报文级细分 | 插件（宿主不管这些） |
| `QUOTA` `AUTH` `CONTEXT_WINDOW_EXCEEDED` `HTTP_413` `RATE_LIMIT` … | 谁都不续 |
| DSML 泄漏形态、`max-tokens` | 插件（宿主没有这个概念） |

开关就是一行配置，判据代码两条都留着，只是不再叠加发送：

```yaml
- id: dsml-guard
  name: dsh-dsml-guard
  config:
    skipHostRetriedCodes: false   # 恢复 0.1.3 的行为：宿主重试耗尽后，插件再补一条继续
```

> **什么时候该切成 `false`**：宿主根本没有这套重试时 —— DSH < 0.2.2，或者从 profile 的
> `cordis.patch.yml` 里摘掉了 `llm-retry` 那一行。注意**删掉 `retryPolicy` 并不等于关掉重试**：
> `llm-deepseek` 的缺省就是 `normal` + 5 次；设置页也只有 `normal` / `always` 两档，没有「关」。
> 另外**不建议把重试策略选成「所有错误」**：那是无上限重试，
> 连 `AUTH / QUOTA / CONTEXT_WINDOW_EXCEEDED` 都会一直重打，正好踩穿本插件刻意保护的边界。
>
> 本插件不监听 `agent/request-error`，与 `llm-retry` 不在同一条 waterfall 上，两者不会互相抢决策。

## 测试

```powershell
node test/run.mjs          # 42 条单元用例，不含真实会话
node test/replay-real.mjs  # 端到端：动态扫描会话存档，把捕获到的泄漏正文原样喂进来
```

`replay-real.mjs` 是验收关键：它要求**围栏外的正文一条标记都不许剩**。
它每次动态扫描 `D:\Program Files (x86)\DSH_Data\sessions`，样本数随存档快照变化、会漂移。
本次实测（2026-11-12）：样本 28 条，清洗后 0 条残留，判定续跑 18 条（12 invoke-block + 6 tail-close）。

`test/history.mjs` 覆盖另一条链路，已并入 `node test/run.mjs` 一起跑：宿主是用 **`block-end` 携带的
完整 block 全文**组装 `AssistantMessage` 落进会话历史的。只清洗 `text-delta` 的话，**屏幕干净、历史仍是脏的**，
下一轮又把标记喂回上游 —— 这正是「上下文被污染」的机制。插件现在把 `block-end` 的文本换成本轮实际发出去的内容，
断言「显示 == 历史」两边都不含标记。

> **0.1.1 起的修正**：`0.1.0` 只处理 `text-delta`，没有覆盖 `block-end`，所以历史里仍会留下标记。

## 与同类插件的覆盖对比（0.1.3 的判定依据）

用户要求「和市场的同类插件涵盖范围比，看是否需要增加一些」。判定口径不是照抄码表，而是
**「发『继续』能不能真正解决」**：本机/上游网络临时波动、单次回复 token 到顶、空响应这类能；
余额/额度/鉴权、上下文总体超限（`CONTEXT_WINDOW_EXCEEDED` / `HTTP_413`，只能新开对话/压缩）这类不能。

调研对象与结论（2026-11-12）：

| 插件 | 层次 / 触发条件 | 对本插件的取舍 |
| --- | --- | --- |
| `dsh-auto-continue` v0.4.7（spix18，[GitHub](https://github.com/spix18/dsh-auto-continue)） | turn 级；`max-tokens` 续；可重试集 `RATE_LIMIT/QUOTA/ACCOUNT_QUOTA/EMPTY_RESPONSE`；`invalid_request_error` 靠报文匹配；默认 20 次、1–2 秒随机退避、用户发消息清零 | 采纳 `max-tokens` 续跑、`EMPTY_RESPONSE`、报文级分类、连续计数+正常回复清零。**不采纳**它的 `QUOTA/RATE_LIMIT` 续跑：本机报文是账号受限/余额不足/定时解禁，1–2 秒后立即发继续无益，且 dsh-llm 已在 step 内带退避重试过 RATE_LIMIT；保留本插件原有「额度类一律不续」的已验收行为 |
| `@aiwayds/dsh-llm-net-retry`（[README](https://github.com/fan56/dsh-llm-net-retry/blob/main/README.md)） | **step 级**有界重试（挂在 `agent/request-error`），非 turn 级继续；官方默认可重试集 `EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT`；分类盲区 `MALFORMED_RESPONSE`、`STREAM_CLOSED`、`PI_AI_ERROR` 兜底（network_error / unexpected EOF / tls bad record MAC 等） | 层次不同、互补不冲突。采纳其可重试集与「分类盲区」清单，补进 `EMPTY_RESPONSE/STREAM_CLOSED/NETWORK_ERROR`；`SERVER/TIMEOUT/TRANSPORT` 本插件已有 |
| `dsh-client-auto-continue`、`@windypro-rourou/dsh-auto-continue` | 浏览器/宿主引擎侧；有暂停、循环打断、按次数换续跑文案、模型回退等 | 与 turn 级 `agent.followup` 不同层，本插件不引入界面/模型回退，保持单一职责 |

本机证据（调研时的临时探针扫全部 v4 会话 317 个 error 轮；探针已清理，数据保留在此）：

- `max-tokens` 有 7 次（`{"kind":"max-tokens"}`，无 error 对象）——改前完全没处理；
- `INVALID_REQUEST` 88 次里大量其实是 `read tcp 127.0.0.1:7863->…: i/o timeout`（本机网络波动被顶层码误分类），
  所以顶层码不足以判定，需**报文级细分**：兜底码（INVALID_REQUEST/CLIENT_ERROR/PI_AI_ERROR/UNKNOWN…）
  报文是传输层信号就续、是「未配置凭据/无此模型/余额不足」就否；
- `UNKNOWN` 里出现过 `未配置凭据，请先登录`（永久错误），按报文否决；
- PI_AI_ERROR 的 `in_flight_budget_exhausted … Retry after in-flight requests settle` 是可重试的，
  正则刻意避开 `credits/add credits` 这类含糊措辞，不误杀。

> 明确永久码（额度/鉴权/上下文/体积）按码否决、信任码本身，不被报文里的网络措辞带偏 —— 这是刻意保留的已验收行为。

## 已知限制

- **只处理流式正文**。如果某个适配器把标记塞进 `reasoning-delta` 而不是 `text-delta` / `block-end`，这里看不到。
- **续跑的判据是启发式的**：`tailCloseMinChars` 这条阈值来自实测分布（完整答案是 755 字符量级，
  空产出是 1 字符量级），80 字符是我在两者之间取的保守值，不是上游给的信号。
- 插件**不改请求**，所以上游该漏还是会漏；它只保证「漏了你也看不见墙，且这一轮不会白跑」。
- **临时错误默认不再兜底**（0.1.4 起）：`EMPTY_RESPONSE/SERVER/TIMEOUT/TRANSPORT` 交给 DSH 的 `llm-retry`
  在 step 内重试（它只有 `normal` / `always` 两档，不提供「完全关闭」的档位），重试耗尽后这一轮就以错误结束，
  不会再有插件补的「继续」。要旧行为就把 `skipHostRetriedCodes` 置 `false`。
