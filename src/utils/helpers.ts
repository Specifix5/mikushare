import { keyExists, withTransaction } from '../db/client';
import { CLEANUP_PERIOD, UNITS_TIME } from './constants';

export const scheduleHourly = (task: () => unknown, delay = 0) => {
  const now = new Date();
  const delayTime = Math.max(
    0,
    delay -
      (now.getUTCMinutes() * 60000 +
        now.getUTCSeconds() * 1000 +
        now.getUTCMilliseconds()),
  );

  setTimeout(() => {
    void task();
    setInterval(
      () => {
        void task();
      },
      CLEANUP_PERIOD * 60 * 60 * 1000,
    );
  }, delayTime);
};

export const parseTime = (str: string): number => {
  return Array.from(str.matchAll(/(\d+)([dh])/g))
    .map((match) => {
      const num = match[1];
      const unit = match[2];

      if (!num || !unit) return 0;
      return Number(num) * (UNITS_TIME[unit] ?? 0);
    })
    .reduce((a, b) => a + b, 0);
};

export const isCrawler = (ua: string | null | undefined): boolean => {
  if (!ua) return false;
  const agent = ua.toLowerCase();

  return (
    agent.includes('discordbot') || // Discord
    agent.includes('slackbot') || // Slack
    agent.includes('twitterbot') || // Twitter
    agent.includes('facebookexternalhit') || // Facebook
    agent.includes('linkedinbot') || // LinkedIn
    agent.includes('telegrambot') || // Telegram
    agent.includes('whatsapp') || // WhatsApp
    agent.includes('skypeuripreview') || // Skype
    agent.includes('bitlybot') || // Bitly
    agent.includes('vkshare') || // VK
    agent.includes('pinterest') || // Pinterest
    agent.includes('redditbot') || // Reddit
    agent.includes('quora link preview') // Quora
  );
};

export const CheckIfKeyValid = async (key: string): Promise<boolean> => {
  return withTransaction(async (tx) => {
    return keyExists(tx, key);
  });
};

export const handleAuth = async (request: Request) => {
  const url = new URL(request.url);
  const accessKey = url.searchParams.get('key');

  if (!accessKey || !(await CheckIfKeyValid(accessKey))) {
    return new Response('Unauthorized', {
      headers: {
        Connection: 'close',
      },
      status: 401,
    });
  }
};
