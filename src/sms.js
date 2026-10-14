// Client for SMS Gateway for Android (capcom6/android-sms-gateway).
// Local server mode: SMS_GATEWAY_URL=http://<phone-ip>:8080/message
// Cloud mode:        SMS_GATEWAY_URL=https://api.sms-gate.app/3rdparty/v1/messages
const { SMS_GATEWAY_URL, SMS_GATEWAY_USER = '', SMS_GATEWAY_PASSWORD = '' } = process.env;

export const smsDryRun = !SMS_GATEWAY_URL;

export async function sendSms(phone, text) {
  if (smsDryRun) {
    console.log(`[sms dry-run] to ${phone}: ${text}`);
    return;
  }

  const auth = Buffer.from(`${SMS_GATEWAY_USER}:${SMS_GATEWAY_PASSWORD}`).toString('base64');
  const res = await fetch(SMS_GATEWAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({ textMessage: { text }, phoneNumbers: [phone] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`SMS gateway gaf HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
}
