/**
 * Browser half of dsh-quote-reply.
 *
 * Two slot entries:
 *
 *  1. `shell.overlay` (root scope) — the floating menu. It watches the
 *     document for a finished text selection and, when the selection does not
 *     belong to an editable field, floats a small Quote / Copy card above it.
 *
 *  2. `conversation.input.overlay` (session scope) — the composer sink. The menu
 *     cannot reach the composer itself (the overlay layer is root scope and
 *     carries no session props), so the two halves meet on the module-local
 *     `sinkHandlers` registry: the sink is the only side that holds
 *     `inputActions`, and it is the side that writes the quote into the draft.
 *     The draft it preserves is read through the `useInput` hook, never a prop:
 *     session slots are fed `props: ['inputActions']` plus the `input` hook.
 *
 *     It lives in the composer's floating layer, never in
 *     `conversation.input.dock`: a bare entry in that strip shifted the whole
 *     conversation on the first keystroke of an IME composition.
 *
 * The quote is plain text: `> line` per line plus a trailing blank line, so
 * the composer keeps ordinary editable text and the selected passage travels
 * to the model inside the message body.
 */

window.__ModuleLoader__.load({
  id: 'dsh-quote-reply',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const NS = 'dsh-quote-reply';
    const OVERLAY_SLOT = 'shell.overlay';
    const SINK_SLOT = 'conversation.input.overlay';
    const MENU_ID = 'quote-reply.menu';
    const SINK_ID = 'quote-reply.sink';

    /* Menu box is fixed-size; placement needs its extents before it mounts. */
    const MENU_W = 158;
    const MENU_H = 40;
    const GAP = 8;

    const ZH = { quote: '引用', copy: '复制', copied: '已复制' };
    const EN = { quote: 'Quote', copy: 'Copy', copied: 'Copied' };

    /* ------------------------------------------------------------------ *
     * shared hand-off registry                                            *
     * ------------------------------------------------------------------ */

    const sinkHandlers = new Set();

    /** Offers one quote to every mounted composer sink; true when one took it. */
    function dispatchQuote(text) {
      let handled = false;
      sinkHandlers.forEach((fn) => {
        try {
          if (fn(text)) handled = true;
        } catch (err) {
          console.error('[dsh-quote-reply] composer sink failed', err);
        }
      });
      return handled;
    }

    /* ------------------------------------------------------------------ *
     * text helpers                                                        *
     * ------------------------------------------------------------------ */

    /** Trims the selection and collapses blank runs so the quote block holds together. */
    function normalizeQuote(raw) {
      return String(raw == null ? '' : raw)
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    /** Markdown blockquote form of the selection. */
    function toQuoteBlock(raw) {
      const body = normalizeQuote(raw);
      if (!body) return '';
      return body
        .split('\n')
        .map((line) => (line ? '> ' + line : '>'))
        .join('\n');
    }

    /* ------------------------------------------------------------------ *
     * table-aware quoting                                                 *
     *                                                                     *
     * A table selection reaches us as tab-separated text, because that is *
     * all `Selection.toString()` can produce. The structure is still in    *
     * the DOM, so read the rows and cells there and rebuild a Markdown     *
     * table instead.                                                      *
     * ------------------------------------------------------------------ */

    function elementOf(node) {
      if (!node) return null;
      return node.nodeType === 1 ? node : node.parentElement;
    }

    /** The one table both ends of the selection sit in, or null. */
    function commonTable(sel) {
      const startEl = elementOf(sel.anchorNode);
      const endEl = elementOf(sel.focusNode);
      const a = startEl && typeof startEl.closest === 'function' ? startEl.closest('table') : null;
      const b = endEl && typeof endEl.closest === 'function' ? endEl.closest('table') : null;
      return a && a === b ? a : null;
    }

    function cellText(cell) {
      return String(cell.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    /**
     * Markdown table for a selection that lies inside one table, or '' when
     * the selection is not a table (or is a single plain cell, which reads no
     * better as a one-row table).
     */
    function selectionTableMarkdown(sel) {
      const table = commonTable(sel);
      if (!table) return '';

      let range = null;
      try {
        range = sel.getRangeAt(0);
      } catch (err) {
        return '';
      }

      const rows = [];
      for (let i = 0; i < table.rows.length; i += 1) {
        const row = table.rows[i];
        let hit = false;
        try {
          hit = range.intersectsNode(row);
        } catch (err) {
          hit = false;
        }
        if (hit) rows.push(row);
      }
      if (rows.length === 0) return '';

      const isHeaderRow = (row) =>
        Array.prototype.some.call(row.cells, (cell) => cell.tagName === 'TH');
      if (rows.length === 1 && !isHeaderRow(rows[0])) return '';

      const grid = rows.map((row) => Array.prototype.map.call(row.cells, cellText));
      const width = grid.reduce((max, cells) => Math.max(max, cells.length), 0);
      if (width === 0) return '';

      const padded = grid.map((cells) => {
        const out = cells.slice();
        while (out.length < width) out.push('');
        return out;
      });

      const escape = (text) => text.replace(/\|/g, '\\|');
      const line = (cells) => '| ' + cells.map(escape).join(' | ') + ' |';
      const header = padded[0];
      const divider = '| ' + header.map(() => '---').join(' | ') + ' |';
      return [line(header), divider].concat(padded.slice(1).map(line)).join('\n');
    }

    function legacyCopy(text) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.left = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (err) {
        return false;
      }
    }

    function copyText(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          return navigator.clipboard.writeText(text).then(
            () => true,
            () => legacyCopy(text),
          );
        }
      } catch (err) {
        /* fall through to the legacy path */
      }
      return Promise.resolve(legacyCopy(text));
    }

    /** True when the node sits inside a field that owns its own selection gestures. */
    function isEditableNode(node) {
      let el = node;
      if (el && el.nodeType !== 1) el = el.parentElement;
      if (!el || typeof el.closest !== 'function') return false;
      return !!el.closest(
        'input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
      );
    }

    /* ------------------------------------------------------------------ *
     * the floating menu                                                   *
     * ------------------------------------------------------------------ */

    function QuoteMenu(props) {
      const t = props.t;
      const [menu, setMenu] = useState(null);
      const [hover, setHover] = useState(null);
      const boxRef = useRef(null);
      const openRef = useRef(false);
      const closeTimer = useRef(null);

      const close = useCallback(() => {
        if (closeTimer.current) {
          window.clearTimeout(closeTimer.current);
          closeTimer.current = null;
        }
        if (!openRef.current) return;
        openRef.current = false;
        setHover(null);
        setMenu(null);
      }, []);

      useEffect(() => () => {
        if (closeTimer.current) window.clearTimeout(closeTimer.current);
      }, []);

      useEffect(() => {
        function place(sel, fallbackX, fallbackY) {
          let rect = null;
          try {
            rect = sel.getRangeAt(0).getBoundingClientRect();
          } catch (err) {
            rect = null;
          }
          const usable = !!rect && (rect.width > 0 || rect.height > 0);
          const left = usable ? rect.left : fallbackX;
          const top = usable ? rect.top : fallbackY;
          const bottom = usable ? rect.bottom : fallbackY;

          const vw = window.innerWidth || 0;
          const vh = window.innerHeight || 0;
          const x = Math.max(GAP, Math.min(left, Math.max(GAP, vw - MENU_W - GAP)));
          let y = top - MENU_H - GAP;
          if (y < GAP) y = Math.min(Math.max(GAP, vh - MENU_H - GAP), bottom + GAP);
          return { x: Math.round(x), y: Math.round(y) };
        }

        function captureFromSelection(fallbackX, fallbackY) {
          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
          const raw = sel.toString();
          /* A selection typed inside the composer is an edit, not a quote. */
          if (isEditableNode(sel.anchorNode) || isEditableNode(sel.focusNode)) return;
          /* A whole-table selection reads better as a Markdown table than as the
           * tab-separated text the browser's clipboard projection produces. */
          const quoted = selectionTableMarkdown(sel) || normalizeQuote(raw);
          if (!quoted) return;

          const pos = place(sel, fallbackX, fallbackY);
          openRef.current = true;
          setHover(null);
          setMenu({ x: pos.x, y: pos.y, raw, quoted, status: null });
        }

        function onMouseUp(e) {
          if (e.button !== 0) return;
          if (boxRef.current && boxRef.current.contains(e.target)) return;
          const x = e.clientX;
          const y = e.clientY;
          /* Let the browser publish the final selection before reading it. */
          window.setTimeout(() => captureFromSelection(x, y), 0);
        }

        function onMouseDown(e) {
          if (boxRef.current && boxRef.current.contains(e.target)) return;
          close();
        }

        function onContextMenu() {
          /* Step aside so the platform menu is never covered by this card. */
          close();
        }

        function onKeyDown(e) {
          if (e.key === 'Escape') close();
        }

        function onSelectionChange() {
          /* Typing fires this on every keystroke; nothing to do while closed. */
          if (!openRef.current) return;
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed) close();
        }

        document.addEventListener('mouseup', onMouseUp, true);
        document.addEventListener('mousedown', onMouseDown, true);
        document.addEventListener('contextmenu', onContextMenu, true);
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('selectionchange', onSelectionChange);
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        return () => {
          document.removeEventListener('mouseup', onMouseUp, true);
          document.removeEventListener('mousedown', onMouseDown, true);
          document.removeEventListener('contextmenu', onContextMenu, true);
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('selectionchange', onSelectionChange);
          window.removeEventListener('scroll', close, true);
          window.removeEventListener('resize', close);
        };
      }, [close]);

      if (!menu) return null;

      function markCopied() {
        setMenu((m) => (m ? { ...m, status: 'copied' } : m));
        closeTimer.current = window.setTimeout(close, 800);
      }

      function onQuote() {
        if (!menu) return;
        if (dispatchQuote(menu.quoted)) {
          close();
          return;
        }
        /* No composer sink is mounted (blank session): keep the passage on the
         * clipboard rather than letting the click do nothing at all. */
        copyText(menu.raw).then(markCopied);
      }

      function onCopy() {
        if (!menu) return;
        copyText(menu.raw).then((ok) => {
          if (!ok) {
            close();
            return;
          }
          markCopied();
        });
      }

      function icon(children) {
        return h(
          'svg',
          {
            width: 14,
            height: 14,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
            style: { display: 'block', flex: '0 0 auto' },
          },
          children,
        );
      }

      function item(key, label, glyph, onClick) {
        return h(
          'button',
          {
            type: 'button',
            key,
            onMouseDown: (e) => e.preventDefault(),
            onClick,
            onMouseEnter: () => setHover(key),
            onMouseLeave: () => setHover((cur) => (cur === key ? null : cur)),
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '5px 9px',
              border: '0',
              borderRadius: '7px',
              background:
                hover === key ? 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.14))' : 'transparent',
              color: 'var(--dsw-alias-label-primary, #1f2329)',
              font: 'inherit',
              fontSize: '13px',
              lineHeight: '18px',
              whiteSpace: 'nowrap',
              cursor: 'pointer',
            },
          },
          glyph,
          h('span', null, label),
        );
      }

      const copied = menu.status === 'copied';

      return h(
        'div',
        {
          ref: boxRef,
          role: 'toolbar',
          style: {
            position: 'fixed',
            left: menu.x + 'px',
            top: menu.y + 'px',
            zIndex: 9999,
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: '2px',
            padding: '4px',
            borderRadius: '10px',
            background: 'var(--dsw-alias-bg-overlay, #ffffff)',
            border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.10))',
            boxShadow: '0 6px 20px rgba(0, 0, 0, 0.16)',
            color: 'var(--dsw-alias-label-primary, #1f2329)',
            font: '13px/18px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
            userSelect: 'none',
          },
        },
        item(
          'quote',
          t('quote'),
          icon(h('polyline', { points: '9 14 4 9 9 4' }), h('path', { d: 'M20 20v-7a4 4 0 0 0-4-4H4' })),
          onQuote,
        ),
        h('div', {
          style: {
            width: '1px',
            alignSelf: 'stretch',
            margin: '2px 1px',
            background: 'var(--dsw-alias-border-l1, rgba(0,0,0,0.10))',
          },
        }),
        item(
          'copy',
          copied ? t('copied') : t('copy'),
          icon(
            h('rect', { x: 9, y: 9, width: 13, height: 13, rx: 2 }),
            h('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }),
          ),
          onCopy,
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * the composer sink                                                   *
     * ------------------------------------------------------------------ */

    function QuoteSink(props) {
      /* The handler must always see the newest props (inputActions) and the
       * newest draft without re-registering on every render.
       *
       * The draft is NOT a prop. A session slot is fed by
       * `ctx.uiSession.provide({ hooks: ['conversation', 'input'], props:
       * ['inputActions'] })`, so it arrives only through the `useInput` hook.
       * Reading `props.input` yields undefined, and treating that as an empty
       * draft makes `setDraft` wipe whatever the user had already typed. */
      const propsRef = useRef(props);
      propsRef.current = props;

      const readInput = props.useInput;
      const input = typeof readInput === 'function' ? readInput((s) => s) : null;
      const inputRef = useRef(input);
      inputRef.current = input;

      useEffect(() => {
        function handler(raw) {
          const p = propsRef.current || {};
          const actions = p.inputActions;
          if (!actions) return false;

          const block = toQuoteBlock(raw);
          if (!block) return false;

          const live = inputRef.current;
          /* null means "the draft is unknown", which is not the same as "". */
          const draft = live && typeof live.draft === 'string' ? live.draft : null;
          const chips = live && Array.isArray(live.occurrences) ? live.occurrences.length : 0;

          /* Aim at the spot the caret holds. `captureInsertion()` answers a
           * revision-guarded span in detect coordinates; with no reference chip
           * on the draft the detect and clipboard projections are the same
           * string, so those offsets index the draft directly. A stale revision,
           * an open selection, or an editor that throws all mean "unknown", and
           * an unknown spot falls back to the end of the draft. */
          let at = draft === null ? 0 : draft.length;
          if (draft !== null && typeof actions.captureInsertion === 'function') {
            try {
              const span = actions.captureInsertion();
              const revOk = span && live && span.draftRev === live.draftRev;
              const collapsed = span && span.start === span.end;
              const inRange = span && span.start >= 0 && span.start <= draft.length;
              if (revOk && collapsed && inRange) at = span.start;
            } catch (err) {
              at = draft.length;
            }
          }

          const prefix = draft === null ? '' : draft.slice(0, at);

          /* Keep the opening `>` on a line of its own so Markdown reads the
           * whole passage as one quote block. */
          const lead = prefix !== '' && !prefix.endsWith('\n') ? '\n' : '';
          const payload = lead + block + '\n\n';

          /* `insertText` pushes a multi-line passage through Lexical's
           * RangeSelection.insertText, which keeps every line inside ONE
           * paragraph as soft line breaks. Typing the same text by hand, or
           * writing it with `setDraft`, yields one paragraph per line — and only
           * the insertText shape made the conversation lurch on the first
           * keystroke of every IME composition (English never did). So write the
           * whole draft instead of inserting into it.
           *
           * `setDraft` replaces the draft wholesale, so it is only safe while
           * the current draft is actually known; an unknown draft keeps the
           * insert path, which never destroys what the user wrote. A draft
           * holding reference chips also keeps it: their clipboard projection
           * has already expanded them to plain text. */
          if (draft !== null && chips === 0 && typeof actions.setDraft === 'function') {
            try {
              actions.setDraft(prefix + payload + draft.slice(at));
              return true;
            } catch (err) {
              console.error('[dsh-quote-reply] setDraft failed, falling back to insertText', err);
            }
          }

          if (typeof actions.insertText !== 'function') return false;

          let span = null;
          try {
            span = actions.captureInsertion();
          } catch (err) {
            span = null;
          }
          if (!span) return false;

          try {
            if (actions.insertText(payload, span)) return true;
          } catch (err) {
            console.error('[dsh-quote-reply] insertText failed', err);
          }
          return false;
        }

        sinkHandlers.add(handler);
        return () => {
          sinkHandlers.delete(handler);
        };
      }, []);

      /* Nothing to draw: this entry exists only to receive `inputActions`. It
       * sits in the composer's floating layer, where a closed entry is the
       * normal state (the slash menu lives there and draws nothing until it
       * opens), so it takes no part in the composer's layout. */
      return null;
    }

    /* ------------------------------------------------------------------ *
     * plugin body                                                         *
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'quote-reply: zh dictionary');
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'quote-reply: en dictionary');
        const t = ctx.locale.bind(NS);

        ctx.effect(
          () =>
            ctx.slots.inject(OVERLAY_SLOT, () =>
              ctx.slots.register({ name: OVERLAY_SLOT, id: MENU_ID, order: 60 }, function QuoteMenuEntry() {
                return h(QuoteMenu, { t });
              }),
            ),
          'quote-reply: selection menu',
        );

        ctx.effect(
          () =>
            ctx.slots.inject(SINK_SLOT, () =>
              ctx.slots.register({ name: SINK_SLOT, id: SINK_ID, order: 300 }, QuoteSink),
            ),
          'quote-reply: composer sink',
        );
      },
    };
  },
});
