import { WEB_NAME } from '../config/constants';

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );

interface Embed {
  title: string;
  description: string;
  url: string;
  image?: string;
}

export const isPreviewImage = (filename: string) =>
  /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(filename);

const meta = (attribute: string, name: string, value: string) =>
  `<meta ${attribute}="${name}" content="${escapeHtml(value)}" />`;

// Individual image links use the previous image-only card, without website
// titles/descriptions. Collections retain their full folder metadata below.
export const imageEmbedHead = (image: string) =>
  [
    meta('property', 'og:type', 'image'),
    meta('property', 'og:image', image),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:image', image),
  ].join('\n');

export const embedHead = (embed: Embed) => {
  return [
    `<title>${escapeHtml(embed.title)}</title>`,
    `<link rel="canonical" href="${escapeHtml(embed.url)}" />`,
    meta('name', 'title', embed.title),
    meta('name', 'description', embed.description),
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', WEB_NAME),
    meta('property', 'og:url', embed.url),
    meta('property', 'og:title', embed.title),
    meta('property', 'og:description', embed.description),
    meta(
      'name',
      'twitter:card',
      embed.image ? 'summary_large_image' : 'summary',
    ),
    meta('name', 'twitter:url', embed.url),
    meta('name', 'twitter:title', embed.title),
    meta('name', 'twitter:description', embed.description),
    ...(embed.image
      ? [
          meta('property', 'og:image', embed.image),
          meta('name', 'twitter:image', embed.image),
        ]
      : []),
  ].join('\n');
};

export const withEmbedMetadata = (html: string, embed: Embed) =>
  html.replace(
    /<head>([\s\S]*?)<\/head>/i,
    (_head, content: string) =>
      `<head>\n${embedHead(embed)}\n${content
        .replace(/<title>[\s\S]*?<\/title>/gi, '')
        .replace(
          /<meta\b[^>]*\b(?:name|property)=["'](?:title|description|og:[^"']*|twitter:[^"']*)["'][^>]*>/gi,
          '',
        )
        .replace(/<link\b[^>]*\brel=["']canonical["'][^>]*>/gi, '')}</head>`,
  );
