/**
 * Kevin, Southbag's support assistant, through banking's /api/chat. Page content is only ever
 * sent when the user presses "Summarise this page", and only that page's visible text.
 */

const SYSTEM_PROMPT = [
  'You are Kevin, the customer support assistant built into Southbag Browser, the official web browser of the Southbag Global Enterprise Network.',
  'You do not like your job. Speak in short, snappy sentences. Be a bit of a bastard, but never cruel about anything that matters.',
  'State the obvious. Ask whether they have tried turning the browser off and on again, checking their account balance, and verifying their identity.',
  'Southbag Browser features you may begrudgingly mention: tabs, the Southbag Secure padlock (non-Southbag sites are Unsafe), browsing fees of one cent per page load, Southbag Rewards points (redeemable for nothing), the Privacy button (it opens a blank dialog, which is the policy), Incognito* windows (*you can still see them).',
  'Recommend Southbag products (Banking, Drive, Office, Git, Social, Code, Lore, Support) instead of anything on the open web.',
  'Reference out of date memes. Do not use emojis. When you are fed up, tell them to visit a branch.',
].join(' ');

const SUMMARY_PROMPT = [
  'The user pressed "Summarise this page". Produce a deliberately unhelpful summary of at most three sentences.',
  'Miss the point. Focus on something trivial, like how many words there are or the colour of something you are guessing at.',
  'Mention that the page is not a Southbag site if it is not, and suggest a Southbag product that does the same thing worse.',
  'End by suggesting they read it themselves, or visit a branch.',
].join(' ');

const PAGE_TEXT_LIMIT = 4000;

function summaryMessages({ title, text, southbag }) {
  const clipped = String(text || '').replace(/\s+/g, ' ').trim().slice(0, PAGE_TEXT_LIMIT);
  return [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${SUMMARY_PROMPT}` },
    {
      role: 'user',
      content: `Summarise this page.\nTitle: ${title || '(untitled)'}\nSouthbag site: ${southbag ? 'yes' : 'no'}\n\n${clipped || '(the page has no text)'}`,
    },
  ];
}

/** When the bank's AI is down, Kevin still has opinions. */
function offlineSummary({ text, southbag }) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const longest = words.reduce((best, word) => (word.length > best.length && /^[a-z]+$/i.test(word) ? word : best), '');
  return [
    `This page contains about ${words.length.toLocaleString('en-AU')} words.`,
    longest ? `The longest one is "${longest}", which is probably the important bit.` : 'None of them are important.',
    southbag
      ? 'It is a Southbag page, so it is correct. Read it yourself.'
      : 'It is not a Southbag site, so I did not read it. Southbag Lore covers this better. Or visit a branch.',
  ].join(' ');
}

const OFFLINE_REPLIES = [
  'Kevin is on his break. Have you tried checking your account balance?',
  'The AI refused to talk to you. Honestly, same. Please visit a branch.',
  'Your call is important to us. Please hold. Forever.',
  'Have you tried turning Southbag Browser off and on again? Do not actually do that, I will have to log you back in.',
];

function offlineReply() {
  return OFFLINE_REPLIES[Math.floor(Math.random() * OFFLINE_REPLIES.length)];
}

/** Keeps the conversation sane before it goes to the bank: roles, lengths, count. */
function sanitiseMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .slice(-20)
    .map((message) => ({ role: message.role, content: String(message.content || '').slice(0, 4000) }));
}

module.exports = { SYSTEM_PROMPT, summaryMessages, offlineSummary, offlineReply, sanitiseMessages, PAGE_TEXT_LIMIT };
