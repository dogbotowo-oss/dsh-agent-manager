/**
 * dsh-agent-manager — client bundle.
 *
 * Adds one button to the conversation header ("代理管理"). Clicking it lists the
 * conversation's subagents and Agent Teams teammates and lets you stop or remove
 * one with a plain left click. The heavy lifting lives in the host plugin
 * (`lib/index.js`), reached over `/agent-manager/api`.
 *
 * No build step: the module loader evaluates this file as a classic script and
 * the factory returns `module.exports` for a cordis client plugin.
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-manager',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const API = '/agent-manager/api';

    async function callApi(route, payload) {
      const response = await fetch(API + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (body === null) throw new Error(`HTTP ${response.status}`);
      if (body.ok !== true) throw new Error(body.error ?? `HTTP ${response.status}`);
      return body.result;
    }

    const style = {
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 28,
        padding: '0 10px',
        borderRadius: 8,
        border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      badge: {
        minWidth: 16,
        height: 16,
        padding: '0 4px',
        borderRadius: 8,
        background: 'var(--dsh-accent, rgba(128,128,128,0.30))',
        color: 'inherit',
        fontSize: 10,
        lineHeight: '16px',
        textAlign: 'center',
      },
      backdrop: { position: 'fixed', inset: 0, zIndex: 2147483000, background: 'transparent' },
      panel: {
        position: 'fixed',
        zIndex: 2147483001,
        width: 460,
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: 'min(70vh, 560px)',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 12,
        border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))',
        background: 'var(--dsh-popover-bg, #1e1f22)',
        color: 'var(--dsh-text, #e9e9ec)',
        boxShadow: '0 18px 48px rgba(0,0,0,0.45)',
        overflow: 'hidden',
        fontSize: 12,
      },
      header: {
        padding: '10px 12px',
        borderBottom: '1px solid var(--dsh-border, rgba(128,128,128,0.25))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
      },
      body: { padding: '6px 0', overflowY: 'auto' },
      section: { padding: '6px 12px 2px', opacity: 0.65, fontSize: 11, letterSpacing: 0.4 },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
      },
      grow: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
      name: { fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      meta: { fontSize: 10.5, opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      small: {
        height: 22,
        padding: '0 8px',
        borderRadius: 6,
        border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 11,
        cursor: 'pointer',
      },
      danger: {
        height: 22,
        padding: '0 8px',
        borderRadius: 6,
        border: '1px solid rgba(239,68,68,0.55)',
        background: 'rgba(239,68,68,0.12)',
        color: '#f87171',
        font: 'inherit',
        fontSize: 11,
        cursor: 'pointer',
      },
      footer: {
        padding: '8px 12px',
        borderTop: '1px solid var(--dsh-border, rgba(128,128,128,0.25))',
        fontSize: 10.5,
        opacity: 0.6,
        lineHeight: 1.5,
      },
      notice: { padding: '6px 12px', fontSize: 11, color: '#4ade80' },
      error: { padding: '6px 12px', fontSize: 11, color: '#f87171', whiteSpace: 'pre-wrap' },
      empty: { padding: '10px 12px', opacity: 0.6 },
    };

    const statusLabel = (value) => {
      if (value === 'running' || value === 'active') return '运行中';
      if (value === 'inactive') return '空闲';
      if (value === 'provisioning') return '启动中';
      if (value === 'failed') return '失败';
      return value ?? '';
    };

    function Row({ item, kind, busy, confirm, onStop, onRemove, onCancel }) {
      const pending = confirm === item.id;
      const label = kind === 'teammate' ? item.name : item.label || item.id;
      const meta = [
        kind === 'teammate' ? '团队成员' : '子代理',
        statusLabel(kind === 'teammate' ? item.status : item.activity),
        item.mode,
        item.id,
      ]
        .filter((part) => part !== undefined && part !== null && part !== '')
        .join(' · ');
      return h(
        'div',
        { style: style.row },
        h(
          'div',
          { style: style.grow },
          h('div', { style: style.name, title: `${label} (${item.id})` }, label),
          h('div', { style: style.meta, title: item.description ?? meta }, item.description ?? meta),
        ),
        pending
          ? [
              h('button', { key: 'yes', style: style.danger, disabled: busy === item.id, onClick: () => onRemove(item, kind) }, busy === item.id ? '移除中…' : '确认移除'),
              h('button', { key: 'no', style: style.small, onClick: onCancel }, '取消'),
            ]
          : [
              h('button', { key: 'stop', style: style.small, disabled: busy === item.id, onClick: () => onStop(item, kind) }, '停止'),
              h('button', { key: 'rm', style: style.danger, disabled: busy === item.id, onClick: () => onRemove(item, kind, true) }, '移除'),
            ],
      );
    }

    function AgentManagerAction(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';
      const [open, setOpen] = useState(false);
      const [anchor, setAnchor] = useState({ top: 0, left: 0 });
      const [view, setView] = useState(null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState(null);
      const [confirm, setConfirm] = useState(null);
      const buttonRef = useRef(null);

      const refresh = useCallback(async () => {
        if (sessionId === '') return;
        setLoading(true);
        setError(null);
        try {
          const result = await callApi('/list', { sessionId });
          setView(result);
        } catch (failure) {
          setView(null);
          setError(String(failure?.message ?? failure));
        } finally {
          setLoading(false);
        }
      }, [sessionId]);

      useEffect(() => {
        if (!open) return undefined;
        refresh();
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [open, refresh]);

      const openPanel = () => {
        const rect = buttonRef.current?.getBoundingClientRect?.();
        if (rect !== undefined && rect !== null) {
          const width = 460;
          const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
          const top = Math.min(rect.bottom + 8, window.innerHeight - 240);
          setAnchor({ top, left });
        }
        setConfirm(null);
        setNotice(null);
        setOpen(true);
      };

      const act = async (route, item, kind) => {
        if (busy !== null) return;
        setBusy(item.id);
        setError(null);
        setNotice(null);
        try {
          const result = await callApi(route, { sessionId, target: item.id });
          const label = kind === 'teammate' ? item.name : item.label || item.id;
          if (route === '/remove') {
            setNotice(`已移除 ${label}（回收站保留会话文件）`);
          } else {
            setNotice(`已停止 ${label}`);
          }
          setConfirm(null);
          await refresh();
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy(null);
        }
      };

      if (sessionId === '') return null;

      const teammates = view?.teammates ?? [];
      const subagents = view?.subagents ?? [];
      const total = teammates.length + subagents.length;
      const live = view?.live === true;

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            ref: buttonRef,
            type: 'button',
            style: style.button,
            title: '管理本会话的子代理与团队成员',
            onClick: openPanel,
          },
          '代理管理',
          h('span', { style: style.badge }, String(total)),
        ),
        open
          ? h(
              React.Fragment,
              null,
              h('div', { style: style.backdrop, onClick: () => setOpen(false) }),
              h(
                'div',
                { style: { ...style.panel, top: anchor.top, left: anchor.left } },
                h(
                  'div',
                  { style: style.header },
                  h('div', { style: { fontWeight: 600 } }, `代理管理${live ? '' : '（会话未在运行，仅显示日志记录）'}`),
                  h('button', { type: 'button', style: style.small, onClick: refresh, disabled: loading }, loading ? '刷新中…' : '刷新'),
                ),
                h(
                  'div',
                  { style: style.body },
                  teammates.length > 0
                    ? [
                        h('div', { key: 'th', style: style.section }, `团队成员 · ${teammates.length}`),
                        ...teammates.map((item) =>
                          h(Row, {
                            key: `t:${item.id}`,
                            item,
                            kind: 'teammate',
                            busy,
                            confirm,
                            onStop: (target) => act('/stop', target, 'teammate'),
                            onRemove: (target, kind, ask) => {
                              if (ask === true) setConfirm(target.id);
                              else act('/remove', target, kind);
                            },
                            onCancel: () => setConfirm(null),
                          }),
                        ),
                      ]
                    : [],
                  subagents.length > 0
                    ? [
                        h('div', { key: 'sh', style: style.section }, `子代理 · ${subagents.length}`),
                        ...subagents.map((item) =>
                          h(Row, {
                            key: `s:${item.id}`,
                            item,
                            kind: 'subagent',
                            busy,
                            confirm,
                            onStop: (target) => act('/stop', target, 'subagent'),
                            onRemove: (target, kind, ask) => {
                              if (ask === true) setConfirm(target.id);
                              else act('/remove', target, kind);
                            },
                            onCancel: () => setConfirm(null),
                          }),
                        ),
                      ]
                    : [],
                  total === 0 && !loading && error === null
                    ? h('div', { style: style.empty }, '本会话没有子代理或团队成员。')
                    : null,
                ),
                notice !== null ? h('div', { style: style.notice }, notice) : null,
                error !== null ? h('div', { style: style.error }, error) : null,
                h(
                  'div',
                  { style: style.footer },
                  '停止 = 结束当前回合并释放运行实例；移除 = 停止 + 退休日志里的目录/花名册记录 + 会话文件移入回收站。移除不可从模型侧撤销，重开会话即可看到效果。',
                ),
              ),
            )
          : null,
      );
    }

    function apply(ctx) {
      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register(
          {
            name: 'agent-manager',
            id: 'agent-manager:header-action',
            order: 65,
          },
          AgentManagerAction,
        ),
      );
    }

    const inject = ['slots'];

    const module = { exports: {} };
    module.exports.apply = apply;
    module.exports.inject = inject;
    module.exports.AgentManagerAction = AgentManagerAction;
    return module.exports;
  },
});
