// The Connect apps catalog.
//
// Like Grok Bot, services without an API connector are used through the shared
// computer's browser: you sign in once, the session persists, and every Bot can
// use it. `auth` lists cookies whose presence means "signed in"; when a service's
// cookies are unknown, status is confirmed when you finish the sign-in and press
// "I'm done".  Mac apps (Calendar, Contacts, Reminders) are native tools.

const C = (id, name, category, url, domains, auth, tips, color) =>
  ({ id, name, category, kind: 'browser', url, domains, auth, tips, color });

export const CATALOG = [
  // Google
  C('gmail', 'Gmail', 'Google', 'https://mail.google.com/', ['google.com'], ['SID', '__Secure-1PSID'],
    'Read, search, label and draft email at mail.google.com. Draft outgoing mail for review unless drafts are off.', '#ea4335'),
  C('gcal', 'Google Calendar', 'Google', 'https://calendar.google.com/', ['google.com'], ['SID', '__Secure-1PSID'],
    'Read and manage events at calendar.google.com. Ask before sending invites.', '#4285f4'),
  C('gdrive', 'Google Drive', 'Google', 'https://drive.google.com/', ['google.com'], ['SID', '__Secure-1PSID'],
    'Find, open, organize and share files at drive.google.com.', '#0f9d58'),
  C('gdocs', 'Google Docs', 'Google', 'https://docs.google.com/document/', ['google.com'], ['SID', '__Secure-1PSID'],
    'Create and edit documents at docs.google.com/document.', '#4285f4'),
  C('gsheets', 'Google Sheets', 'Google', 'https://docs.google.com/spreadsheets/', ['google.com'], ['SID', '__Secure-1PSID'],
    'Read and update spreadsheets at docs.google.com/spreadsheets.', '#0f9d58'),
  C('gslides', 'Google Slides', 'Google', 'https://docs.google.com/presentation/', ['google.com'], ['SID', '__Secure-1PSID'],
    'Build and edit decks at docs.google.com/presentation.', '#f4b400'),
  C('gmeet', 'Google Meet', 'Google', 'https://meet.google.com/', ['google.com'], ['SID', '__Secure-1PSID'],
    'Create meeting links and read meeting details. Meet settings are not edited.', '#00897b'),
  C('ganalytics', 'Google Analytics', 'Google', 'https://analytics.google.com/', ['google.com'], ['SID', '__Secure-1PSID'],
    'Pull traffic and conversion reports.', '#e37400'),
  C('gads', 'Google Ads', 'Google', 'https://ads.google.com/', ['google.com'], ['SID', '__Secure-1PSID'],
    'Read campaign performance. Ask first before changing budgets or bids.', '#4285f4'),

  // Microsoft
  C('outlook', 'Outlook', 'Microsoft', 'https://outlook.office.com/mail/', ['office.com', 'live.com', 'microsoftonline.com', 'outlook.com'],
    ['ESTSAUTH', 'ESTSAUTHPERSISTENT', 'RPSSecAuth', '__Host-MSAAUTH'],
    'Read, search and draft email in Outlook on the web. Draft outgoing mail for review unless drafts are off.', '#0078d4'),
  C('outlookcal', 'Outlook Calendar', 'Microsoft', 'https://outlook.office.com/calendar/', ['office.com', 'live.com', 'microsoftonline.com', 'outlook.com'],
    ['ESTSAUTH', 'ESTSAUTHPERSISTENT', 'RPSSecAuth', '__Host-MSAAUTH'], 'Read and manage Outlook calendar events.', '#0078d4'),
  C('teams', 'Microsoft Teams', 'Microsoft', 'https://teams.microsoft.com/', ['microsoft.com', 'microsoftonline.com', 'live.com'],
    ['ESTSAUTH', 'ESTSAUTHPERSISTENT', 'authtoken', 'RPSSecAuth'],
    'Read chats and channels, draft replies, check meetings in Teams on the web. Draft messages for review unless drafts are off.', '#5b5fc7'),
  C('onedrive', 'OneDrive', 'Microsoft', 'https://onedrive.live.com/', ['live.com', 'microsoftonline.com', 'sharepoint.com'],
    ['ESTSAUTH', 'ESTSAUTHPERSISTENT', 'RPSSecAuth', '__Host-MSAAUTH'], 'Find and manage files in OneDrive.', '#0078d4'),
  C('sharepoint', 'SharePoint', 'Microsoft', 'https://www.office.com/launch/sharepoint', ['sharepoint.com', 'microsoftonline.com'],
    ['ESTSAUTH', 'ESTSAUTHPERSISTENT', 'FedAuth', 'rtFa'], 'Browse sites, lists and documents in SharePoint.', '#038387'),
  C('word', 'Word', 'Microsoft', 'https://www.office.com/launch/word', ['office.com', 'microsoftonline.com', 'live.com'],
    ['ESTSAUTH', 'ESTSAUTHPERSISTENT', 'RPSSecAuth'], 'Create and edit Word documents online.', '#2b579a'),
  C('excel', 'Excel', 'Microsoft', 'https://www.office.com/launch/excel', ['office.com', 'microsoftonline.com', 'live.com'],
    ['ESTSAUTH', 'ESTSAUTHPERSISTENT', 'RPSSecAuth'], 'Read and update Excel workbooks online.', '#217346'),
  C('powerpoint', 'PowerPoint', 'Microsoft', 'https://www.office.com/launch/powerpoint', ['office.com', 'microsoftonline.com', 'live.com'],
    ['ESTSAUTH', 'ESTSAUTHPERSISTENT', 'RPSSecAuth'], 'Build and edit PowerPoint decks online.', '#d24726'),

  // Communication
  C('slack', 'Slack', 'Communication', 'https://app.slack.com/', ['slack.com'], ['d'],
    'Read channels and DMs, search, and draft replies at app.slack.com. Draft messages for review unless drafts are off.', '#4a154b'),
  C('zoom', 'Zoom', 'Communication', 'https://zoom.us/signin', ['zoom.us'], ['_zm_ssid', 'zm_aid'],
    'Schedule meetings, read recordings and transcripts.', '#2d8cff'),
  C('discord', 'Discord', 'Communication', 'https://discord.com/app', ['discord.com'], [],
    'Read servers and DMs, draft messages.', '#5865f2'),
  C('whatsapp', 'WhatsApp', 'Communication', 'https://web.whatsapp.com/', ['whatsapp.com'], [],
    'Read and draft chats on WhatsApp Web. Sign-in uses a QR code from your phone.', '#25d366'),
  C('telegram', 'Telegram', 'Communication', 'https://web.telegram.org/', ['telegram.org'], [],
    'Read and draft chats on Telegram Web.', '#229ed9'),
  C('imessage', 'Messages (Mac)', 'Communication', null, [], [], 'Read recent iMessages and draft replies on this Mac.', '#34c759'),

  // Work tools
  C('notion', 'Notion', 'Work', 'https://www.notion.so/login', ['notion.so'], ['token_v2'],
    'Read, write and organize pages and databases in Notion.', '#191919'),
  C('linear', 'Linear', 'Work', 'https://linear.app/login', ['linear.app'], [],
    'Create, triage and update issues and projects in Linear.', '#5e6ad2'),
  C('jira', 'Jira', 'Work', 'https://id.atlassian.com/login', ['atlassian.com', 'atlassian.net'], ['cloud.session.token', 'tenant.session.token'],
    'Create and update Jira issues, run JQL searches, read boards.', '#0052cc'),
  C('confluence', 'Confluence', 'Work', 'https://id.atlassian.com/login', ['atlassian.com', 'atlassian.net'], ['cloud.session.token', 'tenant.session.token'],
    'Read and write Confluence pages.', '#0052cc'),
  C('asana', 'Asana', 'Work', 'https://app.asana.com/', ['asana.com'], ['ticket'],
    'Manage tasks and projects in Asana.', '#f06a6a'),
  C('trello', 'Trello', 'Work', 'https://trello.com/login', ['trello.com'], ['token'],
    'Manage boards and cards in Trello.', '#0079bf'),
  C('monday', 'monday.com', 'Work', 'https://auth.monday.com/login', ['monday.com'], [],
    'Update boards and items on monday.com.', '#ff3d57'),
  C('clickup', 'ClickUp', 'Work', 'https://app.clickup.com/login', ['clickup.com'], [],
    'Manage tasks and docs in ClickUp.', '#7b68ee'),
  C('airtable', 'Airtable', 'Work', 'https://airtable.com/login', ['airtable.com'], [],
    'Read and update Airtable bases.', '#18bfff'),
  C('calendly', 'Calendly', 'Work', 'https://calendly.com/login', ['calendly.com'], [],
    'Check bookings and share scheduling links.', '#006bff'),
  C('figma', 'Figma', 'Work', 'https://www.figma.com/login', ['figma.com'], [],
    'Open files, read comments, export frames in Figma.', '#a259ff'),
  C('canva', 'Canva', 'Work', 'https://www.canva.com/login', ['canva.com'], [],
    'Create and edit designs in Canva.', '#00c4cc'),
  C('dropbox', 'Dropbox', 'Work', 'https://www.dropbox.com/login', ['dropbox.com'], [],
    'Find, organize and share files in Dropbox.', '#0061ff'),
  C('box', 'Box', 'Work', 'https://account.box.com/login', ['box.com'], [],
    'Find, organize and share files in Box.', '#0061d5'),

  // Engineering
  C('github', 'GitHub', 'Engineering', 'https://github.com/login', ['github.com'], ['user_session', 'logged_in'],
    'Read repos, issues and PRs, review code. The `gh` CLI on this computer also works if signed in.', '#24292f'),
  C('gitlab', 'GitLab', 'Engineering', 'https://gitlab.com/users/sign_in', ['gitlab.com'], ['_gitlab_session'],
    'Read repos, issues and merge requests.', '#fc6d26'),
  C('sentry', 'Sentry', 'Engineering', 'https://sentry.io/auth/login/', ['sentry.io'], ['sentrysid', 'session'],
    'Triage errors and read issue details.', '#362d59'),
  C('pagerduty', 'PagerDuty', 'Engineering', 'https://identity.pagerduty.com/global/authn/authentication', ['pagerduty.com'], [],
    'Read incidents, on-call schedules and acknowledgements. Ask first before acknowledging or resolving.', '#06ac38'),
  C('vercel', 'Vercel', 'Engineering', 'https://vercel.com/login', ['vercel.com'], [],
    'Check deployments and logs.', '#000000'),
  C('datadog', 'Datadog', 'Engineering', 'https://app.datadoghq.com/account/login', ['datadoghq.com'], [],
    'Read dashboards, monitors and logs.', '#632ca6'),

  // Sales & CRM
  C('salesforce', 'Salesforce', 'Sales', 'https://login.salesforce.com/', ['salesforce.com', 'force.com'], ['sid'],
    'Look up and update accounts, contacts, leads and opportunities.', '#00a1e0'),
  C('hubspot', 'HubSpot', 'Sales', 'https://app.hubspot.com/login', ['hubspot.com'], ['hubspotapi', 'hubspotapi-prefs'],
    'Manage contacts, deals, sequences and reports.', '#ff7a59'),
  C('pipedrive', 'Pipedrive', 'Sales', 'https://app.pipedrive.com/auth/login', ['pipedrive.com'], [],
    'Manage deals and activities in Pipedrive.', '#1a1a1a'),
  C('linkedin', 'LinkedIn', 'Sales', 'https://www.linkedin.com/login', ['linkedin.com'], ['li_at'],
    'Research people and companies, read messages, draft outreach. Never send connection requests or messages without approval.', '#0a66c2'),
  C('apollo', 'Apollo', 'Sales', 'https://app.apollo.io/#/login', ['apollo.io'], [],
    'Find leads and enrich contacts.', '#1d1d1f'),
  C('gong', 'Gong', 'Sales', 'https://app.gong.io/', ['gong.io'], [],
    'Read call recordings, transcripts and deal insights.', '#8039df'),

  // Support
  C('zendesk', 'Zendesk', 'Support', 'https://www.zendesk.com/login/', ['zendesk.com'], [],
    'Triage tickets and draft replies.', '#03363d'),
  C('intercom', 'Intercom', 'Support', 'https://app.intercom.com/admins/sign_in', ['intercom.com'], [],
    'Read conversations and draft replies.', '#1f8ded'),
  C('freshdesk', 'Freshdesk', 'Support', 'https://freshdesk.com/login', ['freshdesk.com'], [],
    'Triage tickets and draft replies.', '#25c16f'),

  // Finance & commerce
  C('stripe', 'Stripe', 'Finance', 'https://dashboard.stripe.com/login', ['stripe.com'], [],
    'Read payments, customers and payouts. Never refund, charge or change settings without approval.', '#635bff'),
  C('quickbooks', 'QuickBooks', 'Finance', 'https://qbo.intuit.com/', ['intuit.com'], [],
    'Read invoices and reports, categorize transactions.', '#2ca01c'),
  C('xero', 'Xero', 'Finance', 'https://login.xero.com/', ['xero.com'], [],
    'Read invoices, bills and reports.', '#13b5ea'),
  C('expensify', 'Expensify', 'Finance', 'https://www.expensify.com/', ['expensify.com'], [],
    'File and categorize expenses and receipts.', '#0185ff'),
  C('ramp', 'Ramp', 'Finance', 'https://app.ramp.com/sign-in', ['ramp.com'], [],
    'Review card transactions and receipts.', '#e4f222'),
  C('shopify', 'Shopify', 'Finance', 'https://accounts.shopify.com/store-login', ['shopify.com'], [],
    'Read orders, products and analytics in the Shopify admin.', '#95bf47'),
  C('amazon', 'Amazon', 'Finance', 'https://www.amazon.com/ap/signin', ['amazon.com'], ['at-main', 'sess-at-main'],
    'Track orders and find products. Never place an order without approval.', '#ff9900'),

  // Marketing & social
  C('x', 'X', 'Marketing', 'https://x.com/i/flow/login', ['x.com'], ['auth_token'],
    'Read your timeline, mentions and DMs; draft posts and replies for review.', '#000000'),
  C('instagram', 'Instagram', 'Marketing', 'https://www.instagram.com/accounts/login/', ['instagram.com'], ['sessionid'],
    'Read DMs and insights, draft posts.', '#e1306c'),
  C('facebook', 'Facebook', 'Marketing', 'https://www.facebook.com/login', ['facebook.com'], ['c_user'],
    'Read pages, messages and insights.', '#1877f2'),
  C('metaads', 'Meta Ads Manager', 'Marketing', 'https://adsmanager.facebook.com/', ['facebook.com'], ['c_user'],
    'Read campaign performance. Ask first before changing budgets.', '#1877f2'),
  C('youtube', 'YouTube Studio', 'Marketing', 'https://studio.youtube.com/', ['google.com', 'youtube.com'], ['SID', '__Secure-1PSID'],
    'Read channel analytics and comments.', '#ff0000'),
  C('reddit', 'Reddit', 'Marketing', 'https://www.reddit.com/login/', ['reddit.com'], ['reddit_session', 'token_v2'],
    'Read communities and messages, draft posts.', '#ff4500'),
  C('mailchimp', 'Mailchimp', 'Marketing', 'https://login.mailchimp.com/', ['mailchimp.com'], [],
    'Read audiences and campaign reports, draft campaigns.', '#ffe01b'),

  // People
  C('workday', 'Workday', 'People', 'https://www.myworkday.com/', ['myworkday.com', 'workday.com'], [],
    'Look up time off, pay slips and tasks.', '#0875e1'),
  C('greenhouse', 'Greenhouse', 'People', 'https://app.greenhouse.io/users/sign_in', ['greenhouse.io'], [],
    'Review candidates and scorecards.', '#24a47f'),

  // Mac apps (native tools, no browser)
  { id: 'mac_calendar', name: 'Calendar', category: 'This Mac', kind: 'mac', tools: ['mac_calendar_events', 'mac_calendar_add'],
    tips: 'Read events and add events in the Calendar app on this Mac. Cannot change repeating events or send invites.', color: '#ff3b30' },
  { id: 'mac_contacts', name: 'Contacts', category: 'This Mac', kind: 'mac', tools: ['mac_contacts_search'],
    tips: 'Read-only lookup of names, phone numbers, emails, addresses and birthdays.', color: '#8e8e93' },
  { id: 'mac_reminders', name: 'Reminders', category: 'This Mac', kind: 'mac', tools: ['mac_reminders_list', 'mac_reminders_add', 'mac_reminders_complete'],
    tips: 'Read, add and complete reminders.', color: '#ff9500' },
  { id: 'mac_notify', name: 'Alarms & notifications', category: 'This Mac', kind: 'mac', tools: ['mac_notify'],
    tips: 'Show a notification or set a timer (up to 24 hours) on this Mac.', color: '#5856d6' },
];

// iMessage is read through the Mac Messages database, so it is a Mac tool too.
const im = CATALOG.find((c) => c.id === 'imessage');
Object.assign(im, { kind: 'mac', tools: ['mac_messages_recent'], category: 'This Mac' });

export const byId = Object.fromEntries(CATALOG.map((c) => [c.id, c]));
export const CATEGORIES = [...new Set(CATALOG.map((c) => c.category))];
