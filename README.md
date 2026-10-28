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

从 npm 装（推荐，无需构建授权）：

```powershell
dsh plugin --profile desktop add dsh-dsml-guard
```

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

## 已知限制

- **只处理流式正文**（`text-delta`）。如果某个适配器把标记塞进 `reasoning-delta`，这里看不到。
- **续跑的判据是启发式的**：`tailCloseMinChars` 这条阈值来自实测分布（完整答案是 755 字符量级，
  空产出是 1 字符量级），80 字符是我在两者之间取的保守值，不是上游给的信号。
- 插件**不改请求**，所以上游该漏还是会漏；它只保证「漏了你也看不见墙，且这一轮不会白跑」。
