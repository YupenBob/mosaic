/**
 * Round 2 polish regressions (local QA build).
 *
 * Covers the fixes made from round-2 findings: 44px touch targets, keyboard
 * focus return from the theme menu, canonical + preconnect head links, a
 * labelled video element, and the visitor skip link.
 */
import { defineJourney, waitFor } from '../lib/journey.mjs';
import { mockPublicApi } from '../lib/browser.mjs';

export const area = 'a11y';

const MEDIA_ORIGIN = 'https://mosaic-media.xsanye.cn';

async function openHome(t) {
  await mockPublicApi(t.page);
  await t.goto('/');
  await t.page.locator('a.post-card').first().waitFor();
}

export const journeys = [
  defineJourney({
    id: 'polish-touch-targets',
    title: 'Primary mobile controls reach the 44px touch target',
    priority: 'P1',
    viewport: 'mobile',
    steps: async (t) => {
      await openHome(t);
      const size = async (locator, label) => {
        await locator.first().waitFor({ state: 'attached' });
        const box = await locator.first().evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        });
        t.assert(box.width >= 44 && box.height >= 44, `${label} target is ${box.width}x${box.height}`);
        return box;
      };
      await size(t.page.locator('#theme-menu-toggle'), 'theme menu button');
      await size(t.page.locator('.filter-pill').first(), 'filter pill');
      await size(t.page.locator('.header-nav a').first(), 'header nav link');
      // The floating vertical-feed entry is itself a target; the overlay's icon
      // buttons (e.g. close) must resolve to 44px from CSS — measure a probe
      // element so the assertion does not depend on feed playback timing.
      await size(t.page.locator('.feed-entry-btn').first(), 'vertical feed entry');
      const iconTarget = await t.page.evaluate(() => {
        const probe = document.createElement('button');
        probe.className = 'feed-icon-btn';
        probe.style.position = 'absolute';
        probe.style.visibility = 'hidden';
        document.body.appendChild(probe);
        const rect = probe.getBoundingClientRect();
        const size = { width: rect.width, height: rect.height };
        probe.remove();
        return size;
      });
      t.assert(
        iconTarget.width >= 44 && iconTarget.height >= 44,
        `feed icon button is ${iconTarget.width}x${iconTarget.height}`,
      );
    },
  }),
  defineJourney({
    id: 'polish-theme-focus',
    title: 'Escape closes the theme menu and returns focus to its button',
    priority: 'P1',
    steps: async (t) => {
      await openHome(t);
      const toggle = t.page.locator('#theme-menu-toggle');
      await toggle.focus();
      await t.page.keyboard.press('Enter');
      await waitFor(async () => (await toggle.getAttribute('aria-expanded')) === 'true', { message: 'menu open' });
      await t.page.keyboard.press('Tab');
      await t.page.keyboard.press('ArrowDown');
      await t.page.keyboard.press('Space');
      await t.page.keyboard.press('Escape');
      await waitFor(async () => t.page.evaluate(() => document.activeElement?.id === 'theme-menu-toggle'), {
        message: 'focus returns to the theme toggle',
      });
      t.assertEqual(await toggle.getAttribute('aria-expanded'), 'false', 'menu closed');
    },
  }),
  defineJourney({
    id: 'polish-head-links',
    title: 'Home and post pages expose canonical + media preconnect; 404 is noindex',
    priority: 'P2',
    steps: async (t) => {
      await mockPublicApi(t.page);
      await t.goto('/');
      const home = await t.page.evaluate(() => ({
        canonical: document.querySelector('link[rel="canonical"]')?.href || '',
        preconnect: [...document.querySelectorAll('link[rel="preconnect"]')].map((l) => l.href),
      }));
      t.assert(home.canonical.endsWith('/'), `home canonical should be the site root, got ${home.canonical}`);
      t.assert(
        home.preconnect.some((href) => href.startsWith(MEDIA_ORIGIN)),
        `home should preconnect the media host, got ${home.preconnect.join(',')}`,
      );
      await t.goto('/posts/text-only/');
      const post = await t.page.evaluate(() => ({
        canonical: document.querySelector('link[rel="canonical"]')?.href || '',
        preconnect: [...document.querySelectorAll('link[rel="preconnect"]')].map((l) => l.href),
      }));
      t.assert(post.canonical.endsWith('/posts/text-only/'), `post canonical, got ${post.canonical}`);
      t.assert(
        post.preconnect.some((href) => href.startsWith(MEDIA_ORIGIN)),
        'post page should preconnect the media host',
      );
      const notFound = await t.page.request.get(`${t.base}/posts/does-not-exist/`);
      t.assertEqual(notFound.status(), 404, 'nested 404 status');
      const notFoundHtml = await notFound.text();
      t.assert(/name="robots" content="noindex"/.test(notFoundHtml), '404 document should be noindex');
    },
  }),
  defineJourney({
    id: 'polish-video-label',
    title: 'Video elements carry an accessible name on post pages and note media',
    priority: 'P2',
    steps: async (t) => {
      await mockPublicApi(t.page);
      await t.goto('/posts/my-post/');
      const label = await t.page.locator('video').first().getAttribute('aria-label');
      t.assert(label && label.trim().length > 0, 'post video should have an aria-label');
      await t.goto('/?note=my-post');
      const play = t.page.locator('.note-media-play, .note-video-card').first();
      if (await play.count()) {
        await play.click();
        await waitFor(async () => (await t.page.locator('.note-media-video').count()) > 0, {
          message: 'note video mounted',
        });
        const noteLabel = await t.page.locator('.note-media-video').first().getAttribute('aria-label');
        t.assert(noteLabel && noteLabel.trim().length > 0, 'note video should have an aria-label');
      } else {
        t.note('note media has no play affordance for this post');
      }
    },
  }),
  defineJourney({
    id: 'polish-search-degraded',
    title: 'A failed posts index shows a visible search-unavailable state',
    priority: 'P1',
    steps: async (t) => {
      await mockPublicApi(t.page);
      await t.page.route('**/data/posts-index.json', (route) => route.fulfill({ status: 500, body: 'boom' }));
      await t.goto('/');
      const notice = t.page.locator('.search-unavailable');
      await notice.waitFor({ state: 'visible', timeout: 15000 });
      const input = t.page.locator('.search-input');
      t.assert(await input.isDisabled(), 'search input should be disabled when the index cannot load');
      t.assertEqual(await input.getAttribute('aria-disabled'), 'true', 'aria-disabled on the disabled search');
      t.assert((await notice.innerText()).trim().length > 0, 'the notice should explain the failure');
      // The server-rendered feed stays interactive rather than going blank.
      t.assert((await t.page.locator('a.post-card').count()) >= 14, 'SSR cards remain visible');
    },
  }),
  defineJourney({
    id: 'polish-skip-link',
    title: 'The visitor skip link is the first focus stop and jumps to main',
    priority: 'P2',
    steps: async (t) => {
      await mockPublicApi(t.page);
      await t.goto('/');
      await t.page.evaluate(() => document.body.focus());
      await t.page.keyboard.press('Tab');
      const first = await t.page.evaluate(() => {
        const element = document.activeElement;
        return { className: element?.className || '', href: element?.getAttribute('href') || '' };
      });
      t.assert(
        /skip-link/.test(first.className),
        `first Tab stop should be the skip link, got ${JSON.stringify(first)}`,
      );
      await t.page.keyboard.press('Enter');
      await waitFor(async () => t.page.evaluate(() => document.activeElement?.id === 'main-content'), {
        message: 'skip link focuses main content',
      });
      await t.shot('skip-link');
    },
  }),
];
