"use strict";

class Telegram {
  constructor(config, store, log) {
    this.config = config;
    this.store = store;
    this.log = log;
    this.active = Boolean(config.telegramBotToken && config.telegramChatId);
    this.timer = null;
    this.stopped = false;
  }

  async send(message) {
    if (!this.active) return;
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.config.telegramChatId, text: message }),
      });
      if (!response.ok) this.log("WARN", "Telegram send failed.", { status: response.status });
    } catch (error) {
      this.log("WARN", "Telegram send failed.", { error: error.message });
    }
  }

  start(commandHandler) {
    if (!this.active) return;
    const poll = async () => {
      if (this.stopped) return;
      try {
        const offset = Number(this.store.state.telegramUpdateOffset || 0);
        const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/getUpdates?offset=${offset}&timeout=0`;
        const response = await fetch(url);
        const payload = await response.json();
        const updates = payload.ok && Array.isArray(payload.result) ? payload.result : [];
        for (const update of updates) {
          this.store.state.telegramUpdateOffset = update.update_id + 1;
          const message = update.message;
          if (!message || String(message.chat.id) !== String(this.config.telegramChatId)) continue;
          const command = String(message.text || "").trim().split(/\s+/)[0].toLowerCase().split("@")[0];
          if (["/status", "/pause", "/resume", "/panic", "/dryrun"].includes(command)) {
            await commandHandler(command);
          }
        }
        if (updates.length) this.store.saveState();
      } catch (error) {
        this.log("WARN", "Telegram command polling failed.", { error: error.message });
      } finally {
        if (!this.stopped) this.timer = setTimeout(poll, 3000);
      }
    };
    void poll();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

module.exports = { Telegram };
