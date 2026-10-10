# Sign-in and sign-up emails (owner action)

Sened lets a person finish signing in two ways: open the link in the email, or type the 6-digit code. The code is what makes sign-in work when the link opens in a different browser than the installed app. Supabase only shows the code if the email template contains `{{ .Token }}`.

Where: Supabase dashboard, Authentication, Emails (Email Templates). Edit both templates below, then Save.

Both templates must keep `{{ .ConfirmationURL }}` (the link) and add `{{ .Token }}` (the code). Keep them short.

## Magic Link (existing members signing in)

Subject: `Your Sened sign-in code`

```html
<p>Your Sened code: <strong style="font-size:24px;letter-spacing:4px">{{ .Token }}</strong></p>
<p>Type it in the app, or <a href="{{ .ConfirmationURL }}">tap here to sign in</a>.</p>
<p>ሰነድ ኮድዎ: <strong style="font-size:24px;letter-spacing:4px">{{ .Token }}</strong></p>
<p>በመተግበሪያው ውስጥ ይጻፉት፤ ወይም <a href="{{ .ConfirmationURL }}">ለመግባት እዚህ ይንኩ</a>።</p>
<p>If you did not ask for this, ignore this email. / ይህን ካልጠየቁ ኢሜይሉን ችላ ይበሉ።</p>
```

## Confirm signup (new members)

Subject: `Welcome to Sened - your code`

```html
<p>Welcome to Sened. Your code: <strong style="font-size:24px;letter-spacing:4px">{{ .Token }}</strong></p>
<p>Type it in the app, or <a href="{{ .ConfirmationURL }}">tap here to finish creating your account</a>.</p>
<p>እንኳን ወደ ሰነድ በደህና መጡ። ኮድዎ: <strong style="font-size:24px;letter-spacing:4px">{{ .Token }}</strong></p>
<p>በመተግበሪያው ውስጥ ይጻፉት፤ ወይም <a href="{{ .ConfirmationURL }}">መለያዎን ለመጨረስ እዚህ ይንኩ</a>።</p>
<p>If you did not ask for this, ignore this email. / ይህን ካልጠየቁ ኢሜይሉን ችላ ይበሉ።</p>
```

## Other settings to check

- Authentication, URL Configuration: Site URL is the live app address, and `<site>/sign-in` is in the Redirect URLs list (the link returns there).
- Authentication, Providers, Email: enabled, and "Allow new users to sign up" is ON (sign-up needs it; sign-in passes `shouldCreateUser: false` so unknown emails are refused with a friendly message).
- Email OTP length is 6 (the default), expiry 3600 seconds is fine.
- The built-in sender allows about 2 emails per hour. Set a custom SMTP (Authentication, SMTP Settings) before real members start signing up.

## How the app uses them

- `/sign-up` sends `name` and `phone` as user metadata; the existing trigger copies them into `public.profiles`. If the profile name is still empty after the first sign-in, the app saves it through `/api/profile`.
- `/sign-in` sends nothing that creates an account. An unknown email shows "There is no account with this email yet" with a link to `/sign-up`.
- Both screens show "We sent a code and a link to <email>", a code box, "Send again" (60 second wait) and "Use a different email".
