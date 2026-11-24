// Pulls the readable part out of a WhatsApp message.

import { normalizeMessageContent } from 'baileys';

const isReply = (part) => Boolean(part?.contextInfo?.quotedMessage);

/**
 * Returns null for anything that is not a post worth checking
 * (reactions, stickers, voice notes, polls, deletions, edits and so on).
 */
export function extractPost(msg) {
  const m = normalizeMessageContent(msg?.message);
  if (!m) return null;

  if (m.conversation) return { kind: 'text', text: m.conversation.trim(), isReply: false };

  if (m.extendedTextMessage?.text) {
    return { kind: 'text', text: m.extendedTextMessage.text.trim(), isReply: isReply(m.extendedTextMessage) };
  }

  if (m.imageMessage) {
    return {
      kind: 'image',
      text: (m.imageMessage.caption || '').trim(),
      isReply: isReply(m.imageMessage),
      image: m.imageMessage,
    };
  }

  if (m.videoMessage) {
    return { kind: 'video', text: (m.videoMessage.caption || '').trim(), isReply: isReply(m.videoMessage) };
  }

  if (m.documentMessage) {
    const name = m.documentMessage.fileName || m.documentMessage.title;
    const text = [name ? `Attached file: ${name}` : null, m.documentMessage.caption].filter(Boolean).join('\n');
    return { kind: 'document', text: text.trim(), isReply: isReply(m.documentMessage) };
  }

  if (m.eventMessage) {
    const text = [
      `WhatsApp event: ${m.eventMessage.name || ''}`,
      m.eventMessage.description,
      m.eventMessage.location?.name ? `Where: ${m.eventMessage.location.name}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    return { kind: 'event', text: text.trim(), isReply: false };
  }

  return null;
}

/** WhatsApp sends times as seconds, sometimes wrapped in a Long object. */
export function messageTimeMs(msg) {
  const ts = msg?.messageTimestamp;
  if (ts == null) return 0;
  const seconds = typeof ts === 'object' && typeof ts.toNumber === 'function' ? ts.toNumber() : Number(ts);
  return Number.isFinite(seconds) ? seconds * 1000 : 0;
}
