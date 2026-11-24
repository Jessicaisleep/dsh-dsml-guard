/**
 * dsh-dsml-guard 的设置页（浏览器端）。
 *
 * 落点选择：0.2.2-rc.5 起官方客户端**不再声明** `settings.plugin.item`（第三方插件里那些
 * 注册在当前版本不会渲染），现存可用的是 `settings.section`（整页）与 `settings.general.item`
 * （通用页里的单行）。本插件要放 3 个开关 + 13 个勾选框 + 2 个数字，单行塞不下，所以用
 * `settings.section` 开一页。
 *
 * 写入路径：`ctx.configForms.get('dsml-guard')` —— namespace 就是 profile 里的 entry id。
 * 底层走 `remote.settings.mutate(ns, ops, revision)`；只有宿主 `Config` 里标了 `.volatile()`
 * 的字段写得进去，且改完不重启插件（宿主侧 `loader/volatile-update` 会让它重建配置快照）。
 *
 * 这里刻意不 require `@deepseek-ai/dsh-client-ui-primitives`：它在 asar 里没有独立包目录，
 * 由 __ModuleLoader__ 内联解析，能少一个依赖就少一个。复选框用原生 input 即可。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dsml-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** profile entry id，也是 settings 命名空间。 */
    const NAMESPACE = 'dsml-guard'

    const STYLE_ID = 'dsh-dsml-guard-settings'
    const CSS = `
.dsg-page{display:flex;flex-direction:column;gap:28px;padding:4px 0 24px}
.dsg-block{display:flex;flex-direction:column;gap:4px}
.dsg-block-title{font-size:14px;font-weight:600;line-height:22px}
.dsg-block-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-bottom:6px}
.dsg-row{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsg-row:last-child{border-bottom:none}
.dsg-text{min-width:0}
.dsg-label{font-size:14px;line-height:20px}
.dsg-hint{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px}
.dsg-control{flex:none;display:flex;align-items:center;padding-top:2px}
.dsg-check{width:16px;height:16px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary)}
.dsg-input{width:96px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:13px}
.dsg-tag{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;vertical-align:middle}
.dsg-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsg-busy{opacity:.6}
`

    if (
      typeof document !== 'undefined' &&
      document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) === null
    ) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-dsml-guard'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * 与宿主 `CODE_OPTIONS` 一一对应（field 必须一致，否则写进去的 path 宿主不认）。
     * `group: 'dsh'` 的那些与 DSH 自带「重试策略」重复 —— 用户要求写明并默认不勾。
     */
    const CODE_OPTIONS = [
      {
        field: 'retryEmptyResponse',
        label: '空响应',
        hint: '上游返回了空内容，既没有正文也没有工具调用。',
        group: 'dsh',
      },
      {
        field: 'retryMalformedResponse',
        label: '响应格式错误',
        hint: '上游返回的数据结构无法解析。',
        group: 'dsh',
      },
      {
        field: 'retryQuota',
        label: '配额已用尽',
        hint: '账号额度或余额已耗尽，发继续通常也只会再报一次。',
        group: 'dsh',
      },
      {
        field: 'retryRateLimit',
        label: '请求限流',
        hint: '请求太频繁被上游限流，需要等限流窗口过去。',
        group: 'dsh',
      },
      {
        field: 'retryServer',
        label: '服务器错误',
        hint: '上游返回 5xx 服务器故障。',
        group: 'dsh',
      },
      {
        field: 'retryStreamClosed',
        label: '流提前结束',
        hint: '上游在正常收尾前就关闭了输出流。',
        group: 'dsh',
      },
      {
        field: 'retryTimeout',
        label: '超时',
        hint: '请求超时或流空闲超时，例如「Request timed out.」「pi-ai stream idle timeout」。',
        group: 'dsh',
      },
      {
        field: 'retryTransport',
        label: '网络中断',
        hint: '传输层断开或连接失败，例如「Connection error.」「upstream stream ended before a completion event」。',
        group: 'dsh',
      },
      {
        field: 'retryPiAiError',
        label: '上游流被中断',
        hint: '上游响应流意外中断，例如「Upstream response stream was interrupted」。',
        group: 'plugin',
      },
      {
        field: 'retryUnknown',
        label: '未分类错误',
        hint: '上游返回了无法归类的错误，插件会再按报错文本判断是否值得续跑。',
        group: 'plugin',
      },
      {
        field: 'retryNetworkError',
        label: '网络错误（插件侧）',
        hint: 'DNS、TLS 或 socket 层的网络错误。',
        group: 'plugin',
      },
      {
        field: 'retryMaxTokens',
        label: '输出被截断',
        hint: '单次回复达到输出 token 上限，发继续能接着往下写。',
        group: 'plugin',
      },
      {
        field: 'retryAuth',
        label: '鉴权失败 / 密钥无效',
        hint: 'API 密钥无效或鉴权失败，界面上会显示成「API 密钥无效」。本机实测 44 次里续跑 13 次、7 次跑完整轮 —— 换了密钥或额度之后再发继续确实能接着干。',
        group: 'plugin',
      },
      {
        field: 'retryInvalidRequest',
        label: '请求被上游拒绝',
        hint: '上游返回 400 或非预期拒绝。本机实测 89 次里续跑 54 次、34 次真出内容 —— 其中大量是 `read tcp … i/o timeout` 被误分类成 400，这类续跑有效；真正的坏请求仍会被报文判据拦下。',
        group: 'plugin',
      },
    ]

    /** 订阅 ConfigFormController 的快照（它只有 getSnapshot/subscribe，没有 React 绑定）。 */
    function useFormSnapshot(form) {
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
      React.useEffect(() => {
        setSnapshot(form.getSnapshot())
        const off = form.subscribe(() => setSnapshot(form.getSnapshot()))
        return typeof off === 'function' ? off : undefined
      }, [form])
      return snapshot
    }

    /** 数字输入：编辑期间保留用户输入的原样字符串，失焦/回车时才落到配置里。 */
    function NumberField({ value, min, max, disabled, onCommit }) {
      const [draft, setDraft] = React.useState(String(value))
      React.useEffect(() => {
        setDraft(String(value))
      }, [value])

      const commit = () => {
        const parsed = Number(draft)
        if (!Number.isFinite(parsed)) {
          setDraft(String(value))
          return
        }
        const clamped = Math.max(min, Math.min(max, Math.trunc(parsed)))
        setDraft(String(clamped))
        if (clamped !== value) onCommit(clamped)
      }

      return h('input', {
        className: 'dsg-input',
        type: 'number',
        min,
        max,
        step: 1,
        value: draft,
        disabled,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') commit()
        },
      })
    }

    function TextField({ value, disabled, onCommit }) {
      const [draft, setDraft] = React.useState(value)
      React.useEffect(() => {
        setDraft(value)
      }, [value])
      const commit = () => {
        const next = draft.trim() === '' ? value : draft
        if (next !== value) onCommit(next)
        else setDraft(value)
      }
      return h('input', {
        className: 'dsg-input',
        type: 'text',
        value: draft,
        disabled,
        style: { width: 120 },
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') commit()
        },
      })
    }

    function Row({ label, hint, tag, control }) {
      return h(
        'div',
        { className: 'dsg-row' },
        h(
          'div',
          { className: 'dsg-text' },
          h(
            'div',
            { className: 'dsg-label' },
            label,
            tag === undefined ? null : h('span', { className: 'dsg-tag' }, tag),
          ),
          hint === undefined ? null : h('div', { className: 'dsg-hint' }, hint),
        ),
        h('div', { className: 'dsg-control' }, control),
      )
    }

    function Checkbox({ checked, disabled, onToggle, label }) {
      return h('input', {
        className: 'dsg-check',
        type: 'checkbox',
        checked,
        disabled,
        'aria-label': label,
        onChange: (event) => onToggle(event.target.checked),
      })
    }

    function GuardSettingsPage({ form }) {
      const snapshot = useFormSnapshot(form)
      const value = snapshot.value ?? {}
      // status 不是 ready（还在加载 / 宿主没给这个 ns）或不可写时，整页置灰。
      const locked = snapshot.status !== 'ready' || snapshot.writable === false

      const write = (field, next) => {
        // set 返回 Promise<boolean>；失败时 ConfigFormController 自己会重新拉一遍状态。
        void form.set(field, next)
      }

      const switchRow = (field, label, hint) =>
        h(Row, {
          key: field,
          label,
          hint,
          control: h(Checkbox, {
            checked: value[field] === true,
            disabled: locked,
            label,
            onToggle: (next) => write(field, next),
          }),
        })

      const codeRows = (group) =>
        CODE_OPTIONS.filter((option) => option.group === group).map((option) =>
          h(Row, {
            key: option.field,
            label: option.label,
            hint: option.hint,
            tag: group === 'dsh' ? '与 DSH 设置重复' : undefined,
            control: h(Checkbox, {
              checked: value[option.field] === true,
              disabled: locked,
              label: option.label,
              onToggle: (next) => write(option.field, next),
            }),
          }),
        )

      return h(
        'div',
        { className: locked ? 'dsg-page dsg-busy' : 'dsg-page' },
        h(
          'div',
          { className: 'dsg-block' },
          h('div', { className: 'dsg-block-title' }, '基本开关'),
          h('div', { className: 'dsg-block-desc' }, '改动立即生效，不需要重启 DeepSeek Harness。'),
          switchRow('enabled', '启用插件', '关掉后既不清理泄漏的标记，也不自动补发「继续」。'),
          switchRow(
            'sanitize',
            'DSML 补全',
            '把漏进正文的 DSML 标记抹掉（代码块里的不动，那通常是在讨论语法）。',
          ),
          switchRow(
            'dsmlToFence',
            'DSML 包围栏',
            '整段工具调用漏进正文时，不删内容、包进代码围栏留下，供你查看和复制。关掉会回到「整段删掉」的旧行为（那一轮会等于白跑）。',
          ),
          switchRow(
            'thinkingToReasoning',
            'THINKING 归位',
            '上游把思考内容漏进正文（带 <thinking> 一类标签或干脆没标签）时，把这一段搬进「思考」块显示，不再当成正文。',
          ),
          switchRow(
            'codeLeakFence',
            '代码泄露包围栏',
            '上游把要执行的命令或补丁念进正文（$var=… 开头、*** Begin Patch 整段）时，把这一段包进代码围栏显示。内容不改、不会被执行。',
          ),
          switchRow('autoContinue', '自动补发「继续」', '遇到可续跑的失败时，替你在同一轮补一条继续。'),
          h(Row, {
            key: 'maxConsecutive',
            label: '发送继续指令的最大次数',
            hint: '同一会话连续续跑的上限，达到后停下等人。中间出现一次正常回复就重新计数。',
            control: h(NumberField, {
              value: Number(value.maxConsecutive ?? 3),
              min: 1,
              max: 100,
              disabled: locked,
              onCommit: (next) => write('maxConsecutive', next),
            }),
          }),
          h(Row, {
            key: 'continueText',
            label: '发送的内容',
            hint: '自动补发时用的那句话。',
            control: h(TextField, {
              value: String(value.continueText ?? '继续'),
              disabled: locked,
              onCommit: (next) => write('continueText', next),
            }),
          }),
          h(Row, {
            key: 'tailCloseMinChars',
            label: '正文短于此长度视为「什么都没产出」',
            hint: '只在结尾只剩闭合标签时用来判断这一轮是不是空的。一般不用改。',
            control: h(NumberField, {
              value: Number(value.tailCloseMinChars ?? 80),
              min: 1,
              max: 100000,
              disabled: locked,
              onCommit: (next) => write('tailCloseMinChars', next),
            }),
          }),
        ),

        h(
          'div',
          { className: 'dsg-block' },
          h('div', { className: 'dsg-block-title' }, '与 DSH 自带重试重复的类型'),
          h(
            'div',
            { className: 'dsg-block-desc' },
            '下面这些错误码，DSH 自己的「重试策略」已经会处理。默认不勾选，让 DSH 先重试；只有你想让本插件再兜一层时才勾。',
          ),
          h(
            'div',
            { className: 'dsg-block-desc' },
            '勾选后会先检测 DSH 自带重试此刻是否真的在生效：生效则不叠加「继续」（去 DSH 设置里关掉对应 provider 的重试才轮到本插件）；只有 DSH 这一轮没重试时，勾选才会真正接手。',
          ),
          codeRows('dsh'),
        ),

        h(
          'div',
          { className: 'dsg-block' },
          h('div', { className: 'dsg-block-title' }, '本插件独有的类型'),
          h(
            'div',
            { className: 'dsg-block-desc' },
            'DSH 自带重试不含这些码，默认勾选。取消勾选后，即使报文看起来像网络抖动，也不会自动续跑。',
          ),
          codeRows('plugin'),
        ),

        h(
          'div',
          { className: 'dsg-block' },
          h(
            'div',
            { className: 'dsg-note' },
            snapshot.status === 'ready'
              ? snapshot.writable === false
                ? '当前配置是只读的（可能被更高优先级的配置锁定）。'
                : '这些开关都是即时生效的热配置。'
              : '正在读取插件配置…',
          ),
        ),
      )
    }

    const inject = ['slots', 'configForms']

    function apply(ctx) {
      ctx.effect(() => {
        const forms = ctx.configForms
        if (forms === undefined || typeof forms.get !== 'function') return
        const form = forms.get(NAMESPACE)

        // whileServed 保证插件没被激活时不注册（ns 不出现在 describe 结果里就跳过），
        // 避免设置页出现一个永远读不到配置的空壳。
        const offServed = forms.whileServed([NAMESPACE], () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: NAMESPACE,
                order: 40,
                label: 'DSML 防护',
              },
              () => h(GuardSettingsPage, { form }),
            ),
          ),
        )
        return () => {
          if (typeof offServed === 'function') offServed()
        }
      })
    }

    return { name: 'dsml-guard', inject, apply }
  },
})
