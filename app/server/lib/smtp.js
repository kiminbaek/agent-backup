// smtp.js：v2.6.0 轻量 SMTP 客户端（net + tls，零第三方依赖）
// 支持：SSL(隐式 465) / STARTTLS(587/25) + AUTH LOGIN + UTF-8 主题/正文(base64)
// 设计目标：仅用于"备份通知"这类短文本邮件，覆盖 QQ/163/Gmail 等主流服务商
const net = require('net');
const tls = require('tls');

function encodeHeader(str) {
    // RFC 2047 编码（UTF-8 + base64），用于含中文的 Subject / 显示名
    const b64 = Buffer.from(String(str), 'utf8').toString('base64');
    return `=?UTF-8?B?${b64}?=`;
}

function formatDate(d) {
    // RFC 5322 日期格式，固定英文 locale，避免本地化干扰
    return d.toUTCString().replace('GMT', '+0000');
}

// 一个极简状态机：发送命令并读取一行/多行响应（以 "code " 结尾行为终止）
class SmtpSession {
    constructor(socket) {
        this.sock = socket;
        this.buf = '';
        this.queue = [];
        this.sock.setEncoding('utf8');
        this.sock.on('data', d => this._onData(d));
    }
    _onData(d) {
        this.buf += d;
        let idx;
        while ((idx = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, idx).replace(/\r$/, '');
            this.buf = this.buf.slice(idx + 1);
            this._pushLine(line);
        }
    }
    _pushLine(line) {
        if (!this._pending) { this._stash = (this._stash || []); this._stash.push(line); return; }
        this._pending.lines.push(line);
        // SMTP 多行响应：中间行是 "250-xxx"，最后一行是 "250 xxx"
        if (/^\d{3} /.test(line)) {
            const p = this._pending; this._pending = null;
            const code = parseInt(p.lines[p.lines.length - 1].slice(0, 3), 10);
            p.resolve({ code, lines: p.lines });
            this._drainStash();
        }
    }
    _drainStash() {
        if (this._stash && this._stash.length && this._pending) {
            const s = this._stash; this._stash = [];
            for (const l of s) this._pushLine(l);
        }
    }
    read() {
        return new Promise((resolve, reject) => {
            this._pending = { lines: [], resolve, reject };
            this._drainStash();
        });
    }
    async cmd(text) {
        if (text != null) this.sock.write(text + '\r\n');
        return this.read();
    }
    upgradeTls(host) {
        return new Promise((resolve, reject) => {
            const secure = tls.connect({ socket: this.sock, servername: host, rejectUnauthorized: false }, () => {
                this.sock = secure;
                this.buf = '';
                this._pending = null;
                this._stash = [];
                secure.setEncoding('utf8');
                secure.on('data', d => this._onData(d));
                resolve();
            });
            secure.on('error', reject);
        });
    }
    end() { try { this.sock.end(); } catch (_) { /* ignore */ } }
}

function expect(res, codes, step) {
    const ok = Array.isArray(codes) ? codes.includes(res.code) : res.code === codes;
    if (!ok) throw new Error(`SMTP ${step} 失败: ${res.code} ${(res.lines || []).join(' ')}`);
}

/**
 * 发送一封纯文本邮件
 * @param {object} opt
 *   host, port, secure(bool 隐式SSL), user, pass, from, fromName, to(string|array), subject, text
 */
async function sendMail(opt) {
    const host = opt.host;
    const port = Number(opt.port) || (opt.secure ? 465 : 587);
    const to = Array.isArray(opt.to) ? opt.to : String(opt.to || '').split(/[,;]\s*/).filter(Boolean);
    if (!host) throw new Error('SMTP host 不能为空');
    if (!opt.user) throw new Error('SMTP user 不能为空');
    if (!to.length) throw new Error('收件人不能为空');
    const from = opt.from || opt.user;

    const socket = opt.secure
        ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
        : net.connect({ host, port });
    socket.setTimeout(15000);

    const sess = new SmtpSession(socket);
    const connected = new Promise((resolve, reject) => {
        socket.once(opt.secure ? 'secureConnect' : 'connect', resolve);
        socket.once('error', reject);
        socket.once('timeout', () => reject(new Error('SMTP 连接超时')));
    });
    await connected;

    try {
        expect(await sess.read(), 220, 'greeting');
        let ehlo = await sess.cmd('EHLO agent-backup');
        expect(ehlo, [250], 'EHLO');

        // STARTTLS（非隐式 SSL 时，若服务器支持则升级）
        if (!opt.secure) {
            const supportsStartTls = ehlo.lines.some(l => /STARTTLS/i.test(l));
            if (supportsStartTls) {
                expect(await sess.cmd('STARTTLS'), 220, 'STARTTLS');
                await sess.upgradeTls(host);
                ehlo = await sess.cmd('EHLO agent-backup');
                expect(ehlo, [250], 'EHLO(tls)');
            }
        }

        // AUTH LOGIN
        const a1 = await sess.cmd('AUTH LOGIN');
        expect(a1, 334, 'AUTH LOGIN');
        const u = await sess.cmd(Buffer.from(opt.user, 'utf8').toString('base64'));
        expect(u, 334, 'AUTH user');
        const p = await sess.cmd(Buffer.from(opt.pass || '', 'utf8').toString('base64'));
        expect(p, 235, 'AUTH pass');

        expect(await sess.cmd(`MAIL FROM:<${from}>`), 250, 'MAIL FROM');
        for (const rcpt of to) {
            expect(await sess.cmd(`RCPT TO:<${rcpt}>`), [250, 251], 'RCPT TO');
        }
        expect(await sess.cmd('DATA'), 354, 'DATA');

        const subject = encodeHeader(opt.subject || '(无主题)');
        const fromHeader = opt.fromName ? `${encodeHeader(opt.fromName)} <${from}>` : from;
        const bodyB64 = Buffer.from(String(opt.text || ''), 'utf8').toString('base64')
            .replace(/(.{76})/g, '$1\r\n');
        const message = [
            `From: ${fromHeader}`,
            `To: ${to.join(', ')}`,
            `Subject: ${subject}`,
            `Date: ${formatDate(new Date())}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: base64',
            '',
            bodyB64,
            '.',
        ].join('\r\n');
        expect(await sess.cmd(message), 250, 'message');
        try { await sess.cmd('QUIT'); } catch (_) { /* ignore */ }
        return { ok: true, accepted: to };
    } finally {
        sess.end();
    }
}

module.exports = { sendMail };
