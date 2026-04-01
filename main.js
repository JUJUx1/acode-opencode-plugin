'use strict';

const plugin = {
  name: 'OpenCode AI Assistant',
  version: '2.0.0',

  OPENCODE_URL: 'http://127.0.0.1:4000',

  $panel: null,
  $output: null,
  $input: null,
  $status: null,
  isLoading: false,
  currentSessionId: null,
  currentEventSource: null,

  // ─── Init ────────────────────────────────────────────────────────────────
  async init($page, cacheFile, cacheFileUrl) {
    this._injectStyles();

    editorManager.editor.commands.addCommand({
      name: 'opencode:complete',
      bindKey: { win: 'Ctrl-Shift-Space' },
      exec: () => this.openPanel('complete'),
    });
    editorManager.editor.commands.addCommand({
      name: 'opencode:debug',
      bindKey: { win: 'Ctrl-Shift-D' },
      exec: () => this.openPanel('debug'),
    });
    editorManager.editor.commands.addCommand({
      name: 'opencode:explain',
      bindKey: { win: 'Ctrl-Shift-E' },
      exec: () => this.openPanel('explain'),
    });
    editorManager.editor.commands.addCommand({
      name: 'opencode:generate',
      bindKey: { win: 'Ctrl-Shift-G' },
      exec: () => this.openPanel('generate'),
    });

    this._addToolbarButton();
  },

  // ─── Toolbar ─────────────────────────────────────────────────────────────
  _addToolbarButton() {
    const btn = tag('span', { className: 'icon' });
    btn.textContent = '🤖';
    btn.title = 'OpenCode AI';
    btn.style.cssText = 'cursor:pointer;font-size:17px;padding:0 6px;line-height:1;';
    btn.onclick = () => this.openPanel('menu');
    const toolbar = document.querySelector('#toolbar') || document.querySelector('.toolbar');
    if (toolbar) toolbar.appendChild(btn);
  },

  // ─── Panel ────────────────────────────────────────────────────────────────
  openPanel(mode) {
    if (this.$panel) this.$panel.remove();
    if (this.currentEventSource) { this.currentEventSource.close(); this.currentEventSource = null; }

    const panel = document.createElement('div');
    panel.id = 'oc-panel';
    panel.innerHTML = `
      <div id="oc-header">
        <span id="oc-logo">⚡ OpenCode</span>
        <div id="oc-tabs">
          <button class="oc-tab" data-mode="complete">Complete</button>
          <button class="oc-tab" data-mode="debug">Debug</button>
          <button class="oc-tab" data-mode="explain">Explain</button>
          <button class="oc-tab" data-mode="generate">Generate</button>
        </div>
        <button id="oc-close">✕</button>
      </div>
      <div id="oc-gen-bar" style="display:none">
        <input id="oc-input" placeholder="Describe what to generate (e.g. Express REST API)..." />
      </div>
      <div id="oc-output-wrap">
        <div id="oc-status"></div>
        <pre id="oc-output">Select a mode above to get started.</pre>
      </div>
      <div id="oc-footer">
        <button class="oc-btn" id="oc-run">▶ Run</button>
        <button class="oc-btn" id="oc-copy">📋 Copy</button>
        <button class="oc-btn" id="oc-insert">⬆ Insert</button>
        <button class="oc-btn oc-green" id="oc-save" style="display:none">💾 Save File</button>
        <button class="oc-btn oc-red" id="oc-stop" style="display:none">■ Stop</button>
      </div>
    `;

    document.body.appendChild(panel);
    this.$panel = panel;
    this.$output = panel.querySelector('#oc-output');
    this.$input  = panel.querySelector('#oc-input');
    this.$status = panel.querySelector('#oc-status');

    // Close
    panel.querySelector('#oc-close').onclick = () => {
      if (this.currentEventSource) this.currentEventSource.close();
      panel.remove();
    };

    // Tab clicks
    panel.querySelectorAll('.oc-tab').forEach(btn => {
      btn.onclick = () => this._selectMode(btn.dataset.mode);
    });

    // Buttons
    panel.querySelector('#oc-run').onclick    = () => this._runCurrentMode();
    panel.querySelector('#oc-copy').onclick   = () => this._copy();
    panel.querySelector('#oc-insert').onclick = () => this._insert();
    panel.querySelector('#oc-stop').onclick   = () => this._stop();
    panel.querySelector('#oc-save').onclick   = () => this._saveFile();

    this._selectMode(mode === 'menu' ? 'complete' : mode);
  },

  _currentMode: 'complete',

  _selectMode(mode) {
    this._currentMode = mode;
    this.$panel.querySelectorAll('.oc-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    const genBar = this.$panel.querySelector('#oc-gen-bar');
    genBar.style.display = mode === 'generate' ? 'flex' : 'none';
    this.$output.textContent = mode === 'generate'
      ? 'Describe what file to generate, then tap ▶ Run.'
      : 'Select code in editor (or leave empty for full file), then tap ▶ Run.';
  },

  // ─── Run ─────────────────────────────────────────────────────────────────
  async _runCurrentMode() {
    if (this.isLoading) return;

    const editor  = editorManager.editor;
    const session = editor.getSession();
    const selected = editor.getSelectedText();
    const code     = selected || session.getValue();
    const filename = editorManager.activeFile?.name || 'code.txt';
    const lang     = filename.split('.').pop() || 'code';
    const mode     = this._currentMode;

    let prompt = '';
    if (mode === 'complete') {
      prompt = `Complete this ${lang} code. Return the full completed code only:\n\n${code}`;
    } else if (mode === 'debug') {
      prompt = `Debug this ${lang} code. List the bugs found, then return the fully fixed code:\n\n${code}`;
    } else if (mode === 'explain') {
      prompt = `Explain this ${lang} code clearly and concisely:\n\n${code}`;
    } else if (mode === 'generate') {
      const desc = this.$input?.value?.trim();
      if (!desc) { this._setOutput('⚠️ Please describe what to generate.'); return; }
      prompt = `Generate a complete, working ${lang} file for: ${desc}. Return only the code.`;
    }

    await this._query(prompt, mode === 'generate' || mode === 'complete');
  },

  // ─── OpenCode API ─────────────────────────────────────────────────────────
  async _query(prompt, showSave = false) {
    this.isLoading = true;
    this._setStatus('🔄 Connecting to OpenCode...');
    this._setOutput('');
    this._showStop(true);

    try {
      // 1. Create session (reuse if exists)
      if (!this.currentSessionId) {
        const res = await fetch(`${this.OPENCODE_URL}/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error(`Session create failed: ${res.status}`);
        const data = await res.json();
        this.currentSessionId = data.id;
      }

      const sessionId = this.currentSessionId;

      // 2. Subscribe to SSE events BEFORE sending message
      let outputText = '';
      const es = new EventSource(`${this.OPENCODE_URL}/session/${sessionId}/event`);
      this.currentEventSource = es;

      es.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'message.part.updated') {
            const part = msg.properties?.part;
            if (part?.type === 'text' && part?.text) {
              outputText = part.text;
              this._setOutput(outputText);
            }
          }
          if (msg.type === 'session.idle' || msg.type === 'message.completed') {
            this._setStatus('✅ Done');
            this._done(showSave, outputText);
            es.close();
          }
          if (msg.type === 'session.error') {
            this._setStatus('❌ Error from OpenCode');
            this._done(false, outputText);
            es.close();
          }
        } catch (_) {}
      };

      es.onerror = () => {
        this._setStatus('⚠️ Stream disconnected');
        this._done(showSave, outputText);
        es.close();
      };

      this._setStatus('🤖 OpenCode is thinking...');

      // 3. Send message
      const msgRes = await fetch(`${this.OPENCODE_URL}/session/${sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: prompt }] }),
      });

      if (!msgRes.ok) {
        const err = await msgRes.text();
        throw new Error(`Message failed (${msgRes.status}): ${err}`);
      }

    } catch (e) {
      this._setStatus('❌ Failed');
      this._setOutput(
        `Error: ${e.message}\n\n` +
        `💡 Make sure OpenCode server is running:\n` +
        `   proot-distro login ubuntu\n` +
        `   opencode serve --port 4000`
      );
      this._done(false, '');
    }
  },

  _done(showSave, text) {
    this.isLoading = false;
    this._showStop(false);
    if (showSave && text) {
      this.$panel.querySelector('#oc-save').style.display = 'inline-flex';
    }
  },

  _stop() {
    if (this.currentEventSource) { this.currentEventSource.close(); this.currentEventSource = null; }
    this.isLoading = false;
    this._setStatus('⛔ Stopped');
    this._showStop(false);
  },

  // ─── Helpers ──────────────────────────────────────────────────────────────
  _setOutput(text) {
    if (this.$output) {
      this.$output.textContent = text;
      this.$output.scrollTop = this.$output.scrollHeight;
    }
  },

  _setStatus(text) {
    if (this.$status) this.$status.textContent = text;
  },

  _showStop(show) {
    if (!this.$panel) return;
    this.$panel.querySelector('#oc-stop').style.display = show ? 'inline-flex' : 'none';
    this.$panel.querySelector('#oc-run').style.display  = show ? 'none' : 'inline-flex';
  },

  _copy() {
    const text = this.$output?.textContent || '';
    if (!text || text.startsWith('Select') || text.startsWith('Error')) return;
    navigator.clipboard?.writeText(text);
    acode.alert('Copied', 'Output copied to clipboard.');
  },

  _insert() {
    const text = this.$output?.textContent || '';
    if (!text || text.startsWith('Select') || text.startsWith('Error')) return;
    const editor = editorManager.editor;
    const range  = editor.getSelection().getRange();
    editor.getSession().replace(range, text);
    acode.alert('Inserted', 'Code inserted into editor.');
  },

  async _saveFile() {
    const text = this.$output?.textContent || '';
    if (!text) return;
    const name = await acode.prompt('Filename', 'generated.js', 'text');
    if (name) acode.newFile(name, text);
  },

  // ─── Styles ───────────────────────────────────────────────────────────────
  _injectStyles() {
    if (document.getElementById('oc-styles')) return;
    const s = document.createElement('style');
    s.id = 'oc-styles';
    s.textContent = `
      @keyframes oc-up { from { transform:translateY(100%); opacity:0; } to { transform:translateY(0); opacity:1; } }

      #oc-panel {
        position: fixed; bottom:0; left:0; right:0;
        height: 56vh;
        background: #0d1117;
        border-top: 1.5px solid #21262d;
        border-radius: 14px 14px 0 0;
        display: flex; flex-direction: column;
        z-index: 99999;
        font-family: 'Fira Code', 'Courier New', monospace;
        font-size: 12px;
        box-shadow: 0 -6px 30px rgba(0,0,0,.6);
        animation: oc-up .22s ease;
      }
      #oc-header {
        display: flex; align-items: center; gap:6px;
        padding: 8px 10px;
        border-bottom: 1px solid #21262d;
        flex-shrink: 0;
      }
      #oc-logo { color:#58a6ff; font-weight:700; font-size:13px; white-space:nowrap; }
      #oc-tabs { display:flex; gap:4px; flex:1; flex-wrap:wrap; }
      .oc-tab {
        background:#161b22; border:1px solid #30363d; color:#8b949e;
        padding:3px 8px; border-radius:5px; font-size:11px; cursor:pointer;
      }
      .oc-tab.active { background:#1f6feb; border-color:#388bfd; color:#fff; }
      #oc-close { background:none; border:none; color:#8b949e; font-size:16px; cursor:pointer; flex-shrink:0; }

      #oc-gen-bar {
        padding: 6px 10px; border-bottom:1px solid #21262d; flex-shrink:0;
      }
      #oc-input {
        width:100%; background:#161b22; border:1px solid #30363d; color:#c9d1d9;
        padding:5px 8px; border-radius:6px; font-size:12px; font-family:inherit; box-sizing:border-box;
      }

      #oc-output-wrap { flex:1; display:flex; flex-direction:column; overflow:hidden; }
      #oc-status { padding:3px 12px; font-size:11px; color:#8b949e; flex-shrink:0; min-height:18px; }
      #oc-output {
        flex:1; overflow-y:auto; padding:4px 12px 8px;
        color:#c9d1d9; white-space:pre-wrap; word-break:break-word; margin:0; line-height:1.55;
      }

      #oc-footer {
        display:flex; gap:6px; padding:7px 10px;
        border-top:1px solid #21262d; flex-shrink:0; flex-wrap:wrap;
      }
      .oc-btn {
        background:#21262d; border:1px solid #30363d; color:#c9d1d9;
        padding:4px 10px; border-radius:6px; font-size:11px; cursor:pointer;
        display:inline-flex; align-items:center; gap:3px;
      }
      .oc-btn:active { opacity:.7; }
      .oc-green { background:#196c2e; border-color:#2ea043; color:#fff; }
      .oc-red   { background:#6e1010; border-color:#f85149; color:#fff; }
    `;
    document.head.appendChild(s);
  },

  destroy() {
    if (this.currentEventSource) this.currentEventSource.close();
    this.$panel?.remove();
    document.getElementById('oc-styles')?.remove();
  },
};

if (window.acode) {
  acode.setPluginInit(plugin.name, (e, { cacheFile, cacheFileUrl }) => {
    plugin.init(e, cacheFile, cacheFileUrl);
  });
  acode.setPluginUnmount(plugin.name, () => {
    plugin.destroy();
  });
}
