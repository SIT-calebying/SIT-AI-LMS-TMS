// Default "Welcome — sign in with OTP" email sent after a learner enrols themselves
// from the login page (or staff resolve their sign-in request). Editable under
// Training Provider → Email Templates → Learner Welcome Email; stored in
// training_provider.welcome_signin_email_subject / _body. Client-safe (no server imports).

export const DEFAULT_WELCOME_SIGNIN_SUBJECT = 'Welcome to {COMPANY_SHORT_NAME} — sign in to see your class';

export const DEFAULT_WELCOME_SIGNIN_BODY = `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; line-height: 1.6; max-width: 600px;">
  <p>Hi {LEARNER_NAME},</p>
  <p>You're now enrolled in <strong>{COURSE_NAME}</strong> (Course Run ID {COURSE_RUN_ID}, starting {COURSE_START_DATE}).</p>
  <p>Your class materials, schedule, e-attendance, assessment and certificate are all in the {COMPANY_NAME} Training Management System.</p>
  <p><strong>How to sign in:</strong></p>
  <ol>
    <li>Go to <a href="{LOGIN_URL}">{LOGIN_URL}</a></li>
    <li>Enter your email: <strong>{LEARNER_EMAIL}</strong></li>
    <li>Click <strong>Send OTP</strong> and enter the 6-digit code we email you. No password needed.</li>
  </ol>
  <p style="margin: 20px 0;">
    <a href="{LOGIN_URL}" style="background: #2563eb; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">Sign in to the TMS</a>
  </p>
  <p>Please sign in with the OTP. If the OTP email doesn't arrive within a few minutes, check your spam / junk folder first.</p>
  {PASSWORD_SECTION}
  <br/>
  <p>Warm regards,<br/>{COMPANY_NAME}</p>
</div>`;

export const WELCOME_SIGNIN_VARIABLES = [
  { name: '{LEARNER_NAME}', desc: "Learner's full name" },
  { name: '{LEARNER_EMAIL}', desc: 'Email the learner signs in with' },
  { name: '{COURSE_NAME}', desc: 'Course title' },
  { name: '{COURSE_RUN_ID}', desc: 'Course Run ID' },
  { name: '{COURSE_START_DATE}', desc: 'Class start date' },
  { name: '{LOGIN_URL}', desc: 'Link to this TMS sign-in page' },
  { name: '{PASSWORD_SECTION}', desc: 'New accounts: backup password (must be changed after login). Existing accounts: how to use / reset their password' },
  { name: '{TEMP_PASSWORD}', desc: 'The backup password on its own (blank for existing accounts)' },
  { name: '{COMPANY_NAME}', desc: 'Your company name from Company Settings' },
  { name: '{COMPANY_SHORT_NAME}', desc: 'Your company short name' },
];

export function fillWelcomeSigninTemplate(text: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((out, [key, value]) => out.split(key).join(value), text);
}

// Pre-rendered {PASSWORD_SECTION}: OTP is preferred; the password is a fallback.
export function passwordSectionHtml(tempPassword: string | undefined): string {
  if (!tempPassword) {
    return `<p><strong>Only if the OTP is not working:</strong> click <strong>Login with password instead</strong> and use your existing password, or <strong>Forgot Password</strong> to get a new one.</p>`;
  }
  return `<p><strong>Only if the OTP is not working:</strong> click <strong>Login with password instead</strong> on the sign-in page and use this temporary password. You'll be asked to set your own password straight after signing in.</p>
  <p style="font-size: 18px; font-weight: bold; letter-spacing: 1px; color: #1e40af; background: #eff6ff; padding: 10px 18px; border-radius: 8px; display: inline-block; font-family: monospace;">${tempPassword}</p>`;
}
