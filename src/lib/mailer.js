import nodemailer from 'nodemailer';
import env from '../config/env.js';

let transport = null;

function getTransport() {
  if (transport) return transport;
  if (!env.mailEnabled) return null;

  transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ?? 587,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return transport;
}

/**
 * Without SMTP configured the message is logged instead of sent, so local
 * signup/reset flows stay usable — the link is printed to the console.
 */
async function send({ to, subject, html, text }) {
  const mailer = getTransport();

  if (!mailer) {
    console.info(`[mail:dev] to=${to} subject="${subject}"\n${text ?? html}`);
    return { delivered: false, preview: text ?? html };
  }

  await mailer.sendMail({ from: env.MAIL_FROM, to, subject, html, text });
  return { delivered: true };
}

const layout = (heading, body, cta) => `
  <div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:24px;color:#111">
    <h2 style="margin:0 0 12px">${heading}</h2>
    <p style="line-height:1.6;color:#374151">${body}</p>
    ${cta ? `<p><a href="${cta.href}" style="display:inline-block;background:#0f766e;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${cta.label}</a></p>` : ''}
    <p style="font-size:12px;color:#6b7280">Kaistrum Academy</p>
  </div>`;

export function sendVerificationEmail({ to, name, token }) {
  const href = `${env.APP_URL}/verify-email?token=${token}`;
  return send({
    to,
    subject: 'Verify your Kaistrum Academy email',
    text: `Hi ${name}, confirm your email: ${href}`,
    html: layout(
      `Welcome, ${name}`,
      'Confirm this address to finish setting up your Kaistrum Academy account.',
      { href, label: 'Verify email' },
    ),
  });
}

export function sendPasswordResetEmail({ to, name, token }) {
  const href = `${env.APP_URL}/reset-password?token=${token}`;
  return send({
    to,
    subject: 'Reset your Kaistrum Academy password',
    text: `Hi ${name}, reset your password: ${href} (valid for 1 hour)`,
    html: layout(
      'Reset your password',
      'This link is valid for one hour. If you did not request it you can ignore this email.',
      { href, label: 'Choose a new password' },
    ),
  });
}

export function sendEnrollmentEmail({ to, name, courseTitle, slug }) {
  const href = `${env.APP_URL}/courses/${slug}/learn`;
  return send({
    to,
    subject: `You're enrolled in ${courseTitle}`,
    text: `Hi ${name}, you now have lifetime access to ${courseTitle}: ${href}`,
    html: layout(
      `You're in, ${name}`,
      `You now have lifetime access to <strong>${courseTitle}</strong>.`,
      { href, label: 'Start learning' },
    ),
  });
}
