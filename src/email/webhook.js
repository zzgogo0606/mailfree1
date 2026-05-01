/**
 * 邮件 Webhook 转发模块
 * @module email/webhook
 */

import { extractEmail, normalizeEmailAlias } from '../utils/common.js';

/**
 * 是否启用外部邮件 Webhook
 * @param {object} env
 * @returns {boolean}
 */
export function isWebhookEnabled(env) {
  return !!String(env?.EMAIL_WEBHOOK_URL || '').trim()
    && !!String(env?.EMAIL_WEBHOOK_SECRET || '').trim();
}

/**
 * 将 Worker Email 事件转发到外部 Webhook
 * @param {object} message
 * @param {object} env
 * @returns {Promise<any>}
 */
export async function forwardWorkerEmailToWebhook(message, env) {
  const headers = message?.headers;
  const toHeader = headers?.get('to') || headers?.get('To') || '';
  const fromHeader = headers?.get('from') || headers?.get('From') || '';
  const subject = headers?.get('subject') || headers?.get('Subject') || '(无主题)';
  const messageId = headers?.get('message-id') || headers?.get('Message-ID') || `<${crypto.randomUUID()}@freemail.local>`;

  let envelopeTo = '';
  try {
    const toValue = message?.to;
    if (Array.isArray(toValue) && toValue.length > 0) {
      envelopeTo = typeof toValue[0] === 'string' ? toValue[0] : (toValue[0]?.address || '');
    } else if (typeof toValue === 'string') {
      envelopeTo = toValue;
    }
  } catch (_) { }

  const resolvedRecipient = (envelopeTo || toHeader || '').toString();
  const toAddr = normalizeEmailAlias(extractEmail(resolvedRecipient));

  let rawContent = '';
  try {
    const resp = new Response(message.raw);
    const rawBuffer = await resp.arrayBuffer();
    rawContent = await new Response(rawBuffer).text();
  } catch (_) {
    rawContent = buildRawEmail({
      messageId,
      to: resolvedRecipient || toHeader,
      from: fromHeader,
      subject,
      text: ''
    });
  }

  const payload = {
    message_id: String(messageId || '').trim(),
    to_addr: String(toAddr || '').trim().toLowerCase(),
    raw_content: String(rawContent || '')
  };

  console.log(`[Webhook] 准备发送(Email Event) -> to=${payload.to_addr || 'unknown'} message_id=${payload.message_id || 'unknown'}`);
  return await postEmailWebhook(env, payload);
}

/**
 * 将 HTTP 收信请求转发到外部 Webhook
 * @param {object} emailData
 * @param {object} env
 * @returns {Promise<any>}
 */
export async function forwardHttpEmailToWebhook(emailData, env) {
  const to = String(emailData?.to || '');
  const from = String(emailData?.from || '');
  const subject = String(emailData?.subject || '(无主题)');
  const text = String(emailData?.text || '');
  const html = String(emailData?.html || '');
  const rawMailbox = extractEmail(to);
  const mailbox = normalizeEmailAlias(rawMailbox);
  const messageId = String(emailData?.message_id || emailData?.messageId || '').trim() || `<${crypto.randomUUID()}@freemail.local>`;
  const rawContent = String(emailData?.raw_content || emailData?.rawContent || '').trim() || buildRawEmail({
    messageId,
    to,
    from,
    subject,
    text,
    html
  });

  const payload = {
    message_id: messageId,
    to_addr: String(mailbox || '').trim().toLowerCase(),
    raw_content: rawContent
  };

  console.log(`[Webhook] 准备发送(HTTP Receive) -> to=${payload.to_addr || 'unknown'} message_id=${payload.message_id || 'unknown'}`);
  return await postEmailWebhook(env, payload);
}

async function postEmailWebhook(env, payload) {
  const url = resolveWebhookUrl(String(env?.EMAIL_WEBHOOK_URL || '').trim());
  if (!url) {
    throw new Error('EMAIL_WEBHOOK_URL 未配置');
  }

  console.log(`[Webhook] 开始请求 -> url=${url} to=${payload?.to_addr || 'unknown'} message_id=${payload?.message_id || 'unknown'}`);

  const timeoutMs = Number.parseInt(String(env?.EMAIL_WEBHOOK_TIMEOUT_MS || '10000'), 10) || 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('email-webhook-timeout'), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': String(env?.EMAIL_WEBHOOK_SECRET || '').trim()
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const bodyText = await resp.text();
    console.log(`[Webhook] 请求完成 -> status=${resp.status} ok=${resp.ok} to=${payload?.to_addr || 'unknown'} message_id=${payload?.message_id || 'unknown'}`);

    if (!resp.ok) {
      console.error(`[Webhook] 请求失败 -> status=${resp.status} body=${bodyText}`);
      throw new Error(`Webhook 请求失败: ${resp.status} ${bodyText}`);
    }

    try {
      const data = JSON.parse(bodyText || '{}');
      console.log(`[Webhook] 请求成功 -> response=${JSON.stringify(data)}`);
      return data;
    } catch (_) {
      console.log(`[Webhook] 请求成功 -> raw=${bodyText}`);
      return { success: true, raw: bodyText };
    }
  } finally {
    clearTimeout(timer);
  }
}

function buildRawEmail({ messageId, to, from, subject, text, html }) {
  const safeSubject = String(subject || '(无主题)').replace(/\r?\n/g, ' ').trim();
  const safeTo = String(to || '').replace(/\r?\n/g, ' ').trim();
  const safeFrom = String(from || '').replace(/\r?\n/g, ' ').trim();
  const safeMessageId = String(messageId || `<${crypto.randomUUID()}@freemail.local>`).replace(/\r?\n/g, ' ').trim();
  const plainText = String(text || '').replace(/\r\n/g, '\n');
  const htmlText = String(html || '').replace(/\r\n/g, '\n');

  if (htmlText) {
    const boundary = `freemail-${crypto.randomUUID()}`;
    return [
      `Message-ID: ${safeMessageId}`,
      safeFrom ? `From: ${safeFrom}` : '',
      safeTo ? `To: ${safeTo}` : '',
      `Subject: ${safeSubject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="utf-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      plainText || stripHtml(htmlText),
      `--${boundary}`,
      'Content-Type: text/html; charset="utf-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      htmlText,
      `--${boundary}--`,
      ''
    ].filter(Boolean).join('\r\n');
  }

  return [
    `Message-ID: ${safeMessageId}`,
    safeFrom ? `From: ${safeFrom}` : '',
    safeTo ? `To: ${safeTo}` : '',
    `Subject: ${safeSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    plainText,
    ''
  ].filter(Boolean).join('\r\n');
}

function resolveWebhookUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/api/webhook/email';
    }
    return url.toString();
  } catch (_) {
    return raw;
  }
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCharCode(parseInt(n, 10)); } catch (_) { return ' '; }
    })
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
