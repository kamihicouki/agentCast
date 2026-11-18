/**
 * Detects login redirects or human-verification / CAPTCHA walls.
 * Strict policy: NEVER attempt to solve, click, or bypass any challenge.
 * Immediately return blocked=true so patrol skips the page and notifies the user.
 */
export function checkPageAccessGuard(
  doc: Document,
  pageUrl: string
): { blocked: boolean; reason?: 'auth_required' | 'captcha_detected'; message?: string } {
  const lowerUrl = pageUrl.toLowerCase();

  // Common login redirect paths
  if (
    lowerUrl.includes('x.com/i/flow/login') ||
    lowerUrl.includes('twitter.com/i/flow/login') ||
    lowerUrl.includes('note.com/login') ||
    lowerUrl.includes('accounts.google.com/v3/signin') ||
    lowerUrl.includes('accounts.yahoo.co.jp')
  ) {
    return {
      blocked: true,
      reason: 'auth_required',
      message: 'ログインセッションが切れています。ブラウザで該当サイトにログインしてください。',
    };
  }

  // Anti-bot / CAPTCHA challenge indicators (never interact; halt & notify)
  const hasCaptchaFrame = Boolean(
    doc.querySelector(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], #cf-challenge-running, [data-sitekey]'
    )
  );
  const titleText = (doc.title || '').toLowerCase();
  const bodySample = (doc.body?.innerText || '').slice(0, 1200).toLowerCase();

  if (
    hasCaptchaFrame ||
    titleText.includes('just a moment') ||
    titleText.includes('attention required') ||
    bodySample.includes('verify you are human') ||
    bodySample.includes('人間であることを確認')
  ) {
    return {
      blocked: true,
      reason: 'captcha_detected',
      message:
        'サイト側で確認画面（CAPTCHA等）が表示されたため自動読み取りを停止しました。通常のタブでサイトをご確認ください。',
    };
  }

  return { blocked: false };
}
