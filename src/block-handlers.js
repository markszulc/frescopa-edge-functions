import defaultSiteConfig from './site-config.js';
import { createFaqListBySku } from './blocks/faq-list-by-sku.js';
import { createContentFragment } from './blocks/content-fragment.js';
import { createPageHandler } from './lib/page-handler.js';

export function createBlockHandlers({ site = {}, faqListBySku = {}, contentFragment = {} } = {}) {
  const siteConfig = { ...defaultSiteConfig, ...site };
  const blocks = [
    createFaqListBySku({ ...siteConfig, ...faqListBySku }),
    createContentFragment({ ...siteConfig, ...contentFragment }),
  ];
  const pageHandler = createPageHandler(siteConfig.edsHost, blocks);

  async function handleRequest(req) {
    const pathname = new URL(req.url).pathname;
    const block = req.method === 'GET' && blocks.find(({ dataPath }) => dataPath === pathname);
    return block ? block.dataHandler(req) : pageHandler(req);
  }

  return { blocks, pageHandler, handleRequest };
}

export const { handleRequest: handleBlockRequest } = createBlockHandlers();
