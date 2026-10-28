# dsh-dsml-guard

> 专治 DSML 泄漏：把模型漏进正文的标记抹掉，并在「这一轮其实什么都没产出」时自动补一条 **继续**。
> 只对超时 / 断联 / 空响应这类**重试有意义**的失败续跑；余额、额度、上下文超限一律不动。

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
3. **批量清洗存档**：`_probe/` 下有解码脚本，可写一个就地重写工具 —— 但那是改历史，
   需要单独确认后再做（本插件当前**不**提供这个动作）。


**② 续跑**（`session/event` 的 `turn/end`，通过 `agent.followup()` 补消息）

只在这几种情况下补「继续」：

- `invoke-block` 泄漏 **且** 这一轮没有发出过任何 `tool-call-delta` → 调用确实丢了，一轮没产出；
- `tail-close` 泄漏 **且** 正文短于 `tailCloseMinChars`（默认 80 字符）→ 视为没产出；
- `turn/end` 是 `TIMEOUT` / `TRANSPORT` / `SERVER` / `MALFORMED_RESPONSE` / `PI_AI_ERROR` / `UNKNOWN`。

**不续跑**（发继续也会照样报错，浪费一次往返）：

`QUOTA`、`QUOTA_EXCEEDED`、`ACCOUNT_QUOTA`、`RATE_LIMIT`、`AUTH`、`MISSING_CREDENTIAL`、
`CONTEXT_WINDOW_EXCEEDED`、`UNKNOWN_MODEL`、`HTTP_413`、`INVALID_REQUEST`；
以及 `aborted` / `interrupted`（用户自己按了停，不该替他续）。

还有两道闸：

- **同一会话连续续跑上限** `maxConsecutive`（默认 5，夹在 1–100）；
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

`--profile` 填对方实际在用的那个：
**桌面应用用 `desktop`**，自启的 `dsh web` 服务用 `web`。填错 profile 等于没装 —— 重启多少次都不会加载。

装完**重启 DSH**。

不用 npm 也可以直接从 GitHub 装（锁 tag，内容不会漂移）：

```sh
dsh plugin --profile <profile> add https://github.com/Jessicaisleep/dsh-dsml-guard/archive/refs/tags/v0.1.0.tar.gz
```

> 用 GitHub 源装会在对方机器上跑构建脚本（本包没有构建步骤，只是 pnpm 的常规授权流程），
> 且 `github:owner/repo` 这种简写会被解析成 SSH 地址而匿名被拒，所以上面写的是完整 tar.gz 地址。

改源码时用本地路径装（每次改动后要重新 `add` 一次才生效）：

```powershell
dsh plugin --profile desktop add "file:D:\DSH工作区\DSH插件\dsh-dsml-guard"
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

**发一版只需两条命令：**

```sh
npm version patch        # 或 minor / major，会自动改 package.json 并打 tag
git push --follow-tags   # 推提交 + 推 tag
```

`publish.yml` 在 tag 推送后自动执行：语法检查 → 20 条单元测试 → 校验 tag 与 `package.json` 版本一致 → `npm publish`。
普通提交只触发 `ci.yml`（Node 20/22/24 三档跑测试 + `npm pack --dry-run`），**不会发版**。

### 一次性配置（已经做过，换电脑或换仓库才需要重来）

在 npmjs.com → 该 package → **Settings → Trusted Publisher → GitHub Actions** 填：

| 字段 | 值 |
| --- | --- |
| Organization or user | `Jessicaisleep` |
| Repository | `dsh-dsml-guard` |
| Workflow filename | `publish.yml` |
| Environment | 留空 |

> 配好之后，本地 `pnpm publish` 就不再需要了；也建议到 npm 上**吊销**之前那个 `npm_` token（它现在没用了，留着只是多一个可被滥用的凭据）。

## 配置（可选）

```yaml
- id: dsml-guard
  name: dsh-dsml-guard
  config:
    enabled: true            # 总开关
    sanitize: true           # 抹标记
    autoContinue: true       # 自动补「继续」
    continueText: "继续"
    maxConsecutive: 5        # 连续续跑上限
    tailCloseMinChars: 80    # tail-close 形态下，正文短于这个才续跑
    retryCodes: [TIMEOUT, TRANSPORT, SERVER, MALFORMED_RESPONSE, PI_AI_ERROR, UNKNOWN]
    neverCodes: [QUOTA, QUOTA_EXCEEDED, ACCOUNT_QUOTA, RATE_LIMIT, AUTH,
                 MISSING_CREDENTIAL, CONTEXT_WINDOW_EXCEEDED, UNKNOWN_MODEL,
                 HTTP_413, INVALID_REQUEST]
```

## 测试

```powershell
node test/run.mjs          # 20 条单元用例，不含真实会话
node test/replay-real.mjs  # 端到端：把真实会话里捕获的 29 条泄漏正文原样喂进来
```

`replay-real.mjs` 是验收关键：它要求**围栏外的正文一条标记都不许剩**。
当前结果：样本 29 条，清洗后 0 条残留，判定续跑 19 条（13 invoke-block + 6 tail-close）。

`test/history.mjs` 覆盖另一条链路，已并入 `node test/run.mjs` 一起跑：宿主是用 **`block-end` 携带的
完整 block 全文**组装 `AssistantMessage` 落进会话历史的。只清洗 `text-delta` 的话，**屏幕干净、历史仍是脏的**，
下一轮又把标记喂回上游 —— 这正是「上下文被污染」的机制。插件现在把 `block-end` 的文本换成本轮实际发出去的内容，
断言「显示 == 历史」两边都不含标记。

> **0.1.1 起的修正**：`0.1.0` 只处理 `text-delta`，没有覆盖 `block-end`，所以历史里仍会留下标记。

## 已知限制

- **只处理流式正文**。如果某个适配器把标记塞进 `reasoning-delta` 而不是 `text-delta` / `block-end`，这里看不到。
- **续跑的判据是启发式的**：`tailCloseMinChars` 这条阈值来自实测分布（完整答案是 755 字符量级，
  空产出是 1 字符量级），80 字符是我在两者之间取的保守值，不是上游给的信号。
- 插件**不改请求**，所以上游该漏还是会漏；它只保证「漏了你也看不见墙，且这一轮不会白跑」。
