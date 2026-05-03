// Copyright (c) 2026 ActionNow.AI
// Licensed under the Apache 2.0 license

/**
 * Email templates for group invitation flow.
 *
 * Generates minimal HTML emails — plain text + group name + description +
 * inviter display name + opaque HMAC token URL.
 */

export interface GroupInvitationEmailParams {
  groupName: string;
  groupDescription: string | null;
  inviterDisplayName: string;
  inviterEmail: string;
  acceptUrl: string;
  workspaceHost: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Generate the HTML body for a group invitation email.
 */
export function groupInvitationHtml(
  params: GroupInvitationEmailParams,
): string {
  const {
    groupName,
    groupDescription,
    inviterDisplayName,
    inviterEmail,
    acceptUrl,
    workspaceHost,
  } = params;

  const descriptionBlock = groupDescription
    ? `<p style="color:#6b665c;font-size:14px;margin:0 0 20px">${escapeHtml(groupDescription)}</p>`
    : "";

  const inviterName =
    inviterDisplayName && inviterDisplayName.trim()
      ? inviterDisplayName
      : inviterEmail;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>You've been invited to ${escapeHtml(groupName)} — ActionNow.AI</title>
</head>
<body style="background:#ece8e2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:32px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto">
    <tr>
      <td style="padding-bottom:24px;text-align:center">
        <span style="font-size:22px;font-weight:700;color:#141310;letter-spacing:-0.02em">
          ActionNow.AI
        </span>
        <p style="margin:4px 0 0;font-size:12px;letter-spacing:0.15em;text-transform:uppercase;color:#6b665c">
          Trusted Agent Inbox
        </p>
      </td>
    </tr>
    <tr>
      <td style="background:#f0ede8;border:1px solid #d4d0c8;border-radius:17px;padding:32px">
        <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#141310">
          You've been invited
        </h1>
        <p style="color:#2c2a26;font-size:15px;margin:0 0 20px">
          <strong>${escapeHtml(inviterName)}</strong> has invited you to join
          the <strong>${escapeHtml(groupName)}</strong> group on
          <a href="https://${escapeHtml(workspaceHost)}" style="color:#1b7a28;text-decoration:none">
            ${escapeHtml(workspaceHost)}
          </a>.
        </p>
        ${descriptionBlock}
        <a href="${escapeHtml(acceptUrl)}"
           style="display:inline-block;background:#1b7a28;color:#fff;border-radius:12px;padding:12px 22px;font-size:15px;font-weight:600;text-decoration:none;margin-bottom:20px">
          View invitation →
        </a>
        <p style="color:#9e9e9e;font-size:12px;margin:0">
          If you weren't expecting this invitation, you can ignore this email.
          The link expires in 7 days.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding-top:20px;text-align:center">
        <p style="color:#9e9e9e;font-size:11px;margin:0">
          © ActionNow.AI · This email was sent to you because your address
          was submitted for a group invitation on
          <a href="https://${escapeHtml(workspaceHost)}" style="color:#9e9e9e">${escapeHtml(workspaceHost)}</a>.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Generate the plain-text fallback for a group invitation email.
 */
export function groupInvitationText(
  params: GroupInvitationEmailParams,
): string {
  const {
    groupName,
    groupDescription,
    inviterDisplayName,
    inviterEmail,
    acceptUrl,
    workspaceHost,
  } = params;

  const inviterName =
    inviterDisplayName && inviterDisplayName.trim()
      ? inviterDisplayName
      : inviterEmail;

  const descLine = groupDescription ? `\n${groupDescription}\n` : "";

  return [
    `You've been invited to join the "${groupName}" group on ${workspaceHost}.`,
    "",
    `Invited by: ${inviterName}`,
    descLine,
    `View your invitation:`,
    acceptUrl,
    "",
    "If you weren't expecting this invitation, you can safely ignore this email.",
    "The link expires in 7 days.",
  ].join("\n");
}
