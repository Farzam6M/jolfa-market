/**
 * Hero Slider — clean rebuild.
 *
 * Design rules this file follows:
 *  - No global variables. Everything lives inside the closure created by
 *    initHeroSlider(); nothing is attached to `window`.
 *  - No HTML string injection. Every node is built with document.createElement
 *    and DOM properties (textContent, classList, setAttribute) — innerHTML is
 *    never used.
 *  - No inline event handlers (no onclick="..." anywhere). Every interaction
 *    is wired with addEventListener.
 *  - No manual layout math. There is no translateX(), no `flex-basis: n%`,
 *    no computed pixel offsets. Horizontal layout and swipe are handled
 *    entirely by native CSS scroll-snap; the active slide is detected with
 *    IntersectionObserver. The browser owns layout, this file only owns state.
 *
 * State shape (single source of truth, held in a closure variable):
 *   { status: 'loading' | 'ready' | 'empty' | 'error', slides: [], activeIndex: 0 }
 */

const HERO_API_PATH = '/hero';
const AUTOPLAY_MS = 6000;
const SAFE_HREF_REGEX = /^(https?:\/\/|\/)/i;
const VALID_IMAGE_REGEX = /^(https?:\/\/|\/uploads\/)/i;

/** Same convention the rest of the app uses: window.JOLFA_API_BASE_URL if the
 *  host page defined it, otherwise <origin>/api/v1. Read-only lookup — this
 *  module never assigns to `window`. */
function getApiBaseUrl() {
  if (typeof window !== 'undefined' && window.JOLFA_API_BASE_URL) {
    return window.JOLFA_API_BASE_URL;
  }
  return `${window.location.origin}/api/v1`;
}

/** Resolves a possibly-relative backend asset path (e.g. "/uploads/x.png")
 *  against the API's origin, so it loads correctly regardless of where the
 *  frontend itself is served from. Absolute http(s) URLs pass through as-is. */
function resolveAssetUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  try {
    return new URL(getApiBaseUrl()).origin + url;
  } catch {
    return url;
  }
}

function isValidImageValue(value) {
  const trimmed = String(value || '').trim();
  return !!trimmed && VALID_IMAGE_REGEX.test(trimmed);
}

function isSafeHref(value) {
  const trimmed = String(value || '').trim();
  return !!trimmed && SAFE_HREF_REGEX.test(trimmed);
}

/**
 * Pure mapper: raw HeroSlide API record -> UI slide model.
 * Never mutates its input. Returns null for a record that isn't renderable
 * (no title, or no valid desktop image) instead of silently letting a
 * broken slide reach the DOM.
 */
function mapApiSlideToUiSlide(raw) {
  const title = String(raw?.title || '').trim();
  if (!title || !isValidImageValue(raw?.desktopImageUrl)) return null;

  const position = ['left', 'right', 'center'].includes(raw?.contentPosition)
    ? raw.contentPosition
    : 'right';

  return {
    id: raw.id,
    title,
    subtitle: String(raw?.subtitle || '').trim(),
    description: String(raw?.description || '').trim(),
    image: resolveAssetUrl(String(raw.desktopImageUrl).trim()),
    mobileImage: isValidImageValue(raw?.mobileImageUrl)
      ? resolveAssetUrl(String(raw.mobileImageUrl).trim())
      : '',
    primaryText: String(raw?.primaryButtonText || '').trim(),
    primaryHref: isSafeHref(raw?.primaryButtonLink) ? raw.primaryButtonLink.trim() : '',
    secondaryText: String(raw?.secondaryButtonText || '').trim(),
    secondaryHref: isSafeHref(raw?.secondaryButtonLink) ? raw.secondaryButtonLink.trim() : '',
    position,
  };
}

function mapApiSlidesToUiSlides(rawList) {
  if (!Array.isArray(rawList)) return [];
  return rawList
    .map(mapApiSlideToUiSlide)
    .filter((slide) => slide !== null);
}

/** GET /api/v1/hero — public endpoint, no auth required. */
async function fetchHeroSlides() {
  const response = await fetch(`${getApiBaseUrl()}${HERO_API_PATH}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Hero API responded with status ${response.status}`);
  }
  const body = await response.json();
  // The project's ApiResponse wrapper puts the payload in `.data`; fall back
  // to a bare array for a plain-array response so this stays resilient to
  // either shape.
  const rawList = Array.isArray(body) ? body : body?.data;
  return mapApiSlidesToUiSlides(rawList);
}

/**
 * Builds one <div class="jhs-slide"> node for a UI slide, entirely via DOM
 * APIs. No innerHTML, no onclick attributes — the caller wires listeners.
 */
function createSlideElement(slide, index, total) {
  const el = document.createElement('div');
  el.className = 'jhs-slide';
  el.dataset.index = String(index);
  el.dataset.position = slide.position;
  el.setAttribute('role', 'group');
  el.setAttribute('aria-roledescription', 'slide');
  el.setAttribute('aria-label', `اسلاید ${index + 1} از ${total}`);

  const picture = document.createElement('picture');
  picture.className = 'jhs-slide-picture';

  if (slide.mobileImage) {
    const source = document.createElement('source');
    source.media = '(max-width: 768px)';
    source.srcset = slide.mobileImage;
    picture.appendChild(source);
  }

  const img = document.createElement('img');
  img.className = 'jhs-slide-img';
  img.src = slide.image;
  img.alt = slide.title;
  img.loading = index === 0 ? 'eager' : 'lazy';
  img.decoding = 'async';
  if (index === 0) img.setAttribute('fetchpriority', 'high');
  // If the image 404s / fails to load, mark the slide instead of leaving a
  // blank hole — the CSS gives `.jhs-slide.jhs-img-broken` a neutral fallback
  // background so text/buttons stay legible and the slide never renders empty.
  img.addEventListener('error', () => el.classList.add('jhs-img-broken'), { once: true });
  picture.appendChild(img);

  const overlay = document.createElement('div');
  overlay.className = 'jhs-slide-overlay';

  const content = document.createElement('div');
  content.className = `jhs-slide-content jhs-pos-${slide.position}`;

  if (slide.subtitle) {
    const label = document.createElement('div');
    label.className = 'jhs-slide-label';
    label.textContent = slide.subtitle;
    content.appendChild(label);
  }

  const title = document.createElement('h1');
  title.className = 'jhs-slide-title';
  title.textContent = slide.title;
  content.appendChild(title);

  if (slide.description) {
    const desc = document.createElement('p');
    desc.className = 'jhs-slide-desc';
    desc.textContent = slide.description;
    content.appendChild(desc);
  }

  if (slide.primaryText || slide.secondaryText) {
    const btnRow = document.createElement('div');
    btnRow.className = 'jhs-slide-btns';

    if (slide.primaryText) {
      const primary = document.createElement(slide.primaryHref ? 'a' : 'button');
      primary.className = 'btn-primary jhs-slide-btn';
      primary.textContent = slide.primaryText;
      if (slide.primaryHref) primary.href = slide.primaryHref;
      else primary.type = 'button';
      btnRow.appendChild(primary);
    }
    if (slide.secondaryText) {
      const secondary = document.createElement(slide.secondaryHref ? 'a' : 'button');
      secondary.className = 'btn-ghost jhs-slide-btn';
      secondary.textContent = slide.secondaryText;
      if (slide.secondaryHref) secondary.href = slide.secondaryHref;
      else secondary.type = 'button';
      btnRow.appendChild(secondary);
    }
    content.appendChild(btnRow);
  }

  el.appendChild(picture);
  el.appendChild(overlay);
  el.appendChild(content);
  return el;
}

function createArrowElement(direction) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `jhs-arrow jhs-arrow-${direction}`;
  btn.setAttribute('aria-label', direction === 'prev' ? 'اسلاید قبلی' : 'اسلاید بعدی');

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const points = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  points.setAttribute('points', direction === 'prev' ? '9 18 15 12 9 6' : '15 18 9 12 15 6');
  svg.appendChild(points);
  btn.appendChild(svg);
  return btn;
}

function createDotElement(index) {
  const dot = document.createElement('button');
  dot.type = 'button';
  dot.className = 'jhs-dot';
  dot.dataset.index = String(index);
  dot.setAttribute('role', 'tab');
  dot.setAttribute('aria-label', `اسلاید ${index + 1}`);
  return dot;
}

/**
 * Initializes the Hero Slider inside the given mount element.
 * Everything below is local to this call — no shared/global state between
 * multiple mounts, no state left behind on `window`.
 *
 * Returns a small controller `{ reload }` so the host page can ask this
 * specific instance to re-fetch from the API (e.g. right after an admin
 * create/edit/delete/reorder/toggle call succeeds elsewhere on the same
 * page) without a full browser refresh. This module still never touches
 * `window` itself — wiring that trigger up to admin actions is the host
 * page's job, same as every other cross-component call in this app.
 */
export function initHeroSlider(mountEl) {
  if (!mountEl) return null;

  /** @type {{status: 'loading'|'ready'|'empty'|'error', slides: any[], activeIndex: number}} */
  const state = { status: 'loading', slides: [], activeIndex: 0 };

  let track = null;
  let dotsWrap = null;
  let intersectionObserver = null;
  let autoplayTimer = null;
  let isPointerDown = false;
  let preloadLinkEl = null;

  const prefersReducedMotion = !!(
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  function clearAutoplay() {
    if (autoplayTimer) {
      clearInterval(autoplayTimer);
      autoplayTimer = null;
    }
    if (track) track.setAttribute('aria-live', 'polite');
  }

  function startAutoplay() {
    clearAutoplay();
    if (track) track.setAttribute('aria-live', 'off');
    if (state.status !== 'ready') return;
    if (state.slides.length <= 1) return;
    if (prefersReducedMotion) return;
    if (isPointerDown) return;
    autoplayTimer = setInterval(() => {
      goToIndex((state.activeIndex + 1) % state.slides.length);
    }, AUTOPLAY_MS);
  }

  /** Scrolls only the horizontal track container to the target slide — never
   *  the page. scrollIntoView() was used here before, but it walks up every
   *  scrollable ancestor (not just the track) to decide what needs to move;
   *  since .jhs-track has overflow-y:hidden (it can't scroll vertically),
   *  the next scrollable ancestor it finds is the page itself. If the Hero
   *  section was scrolled out of view, that made scrollIntoView() yank the
   *  whole page back to the top on every slide change (including autoplay).
   *  scrollTo() on the track itself only ever touches the track's own
   *  horizontal scroll position, so the page's scroll position is never
   *  touched. The pixel delta is still measured by the browser (via
   *  getBoundingClientRect), not hardcoded from slide widths, so this stays
   *  correct in RTL too. */
  function goToIndex(index) {
    const total = state.slides.length;
    if (total === 0) return;
    const nextIndex = ((index % total) + total) % total;
    const targetEl = track.children[nextIndex];
    if (!targetEl) return;
    const deltaLeft = targetEl.getBoundingClientRect().left - track.getBoundingClientRect().left;
    track.scrollTo({
      left: track.scrollLeft + deltaLeft,
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
    });
    // IntersectionObserver will confirm/update activeIndex once the scroll
    // settles; setting it here too keeps dots/aria in sync immediately for
    // click/keyboard navigation instead of waiting a frame.
    setActiveIndex(nextIndex);
  }

  function setActiveIndex(index) {
    if (index === state.activeIndex && dotsWrap?.children[index]?.classList.contains('jhs-dot-active')) {
      return;
    }
    state.activeIndex = index;
    if (track) {
      Array.prototype.forEach.call(track.children, (slideEl, i) => {
        slideEl.classList.toggle('jhs-slide-active', i === index);
      });
    }
    if (dotsWrap) {
      Array.prototype.forEach.call(dotsWrap.children, (dot, i) => {
        dot.classList.toggle('jhs-dot-active', i === index);
        dot.setAttribute('aria-selected', i === index ? 'true' : 'false');
      });
    }
  }

  function teardownObserver() {
    if (intersectionObserver) {
      intersectionObserver.disconnect();
      intersectionObserver = null;
    }
  }

  /** Hints the browser to fetch the first slide's image at high priority
   *  before layout — on top of the <img loading="eager" fetchpriority="high">
   *  already on that element. Only ever one such link at a time; a later
   *  reload() (e.g. right after an admin edit) removes the previous hint
   *  instead of piling up stale <link> tags in <head>. */
  function applyFirstSlidePreload(slides) {
    if (preloadLinkEl) {
      preloadLinkEl.remove();
      preloadLinkEl = null;
    }
    const firstImage = slides[0]?.image;
    if (!firstImage || typeof document === 'undefined') return;
    const link = document.createElement('link');
    link.rel = 'preload';
    link.as = 'image';
    link.href = firstImage;
    document.head.appendChild(link);
    preloadLinkEl = link;
  }

  function setupObserver() {
    teardownObserver();
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        // Pick the most-visible intersecting slide as the active one — this
        // is the only place activeIndex is derived from real layout instead
        // of from an intent (click/autoplay), so it stays correct even
        // during user-driven swipe scrolling.
        let best = null;
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          if (!best || entry.intersectionRatio > best.intersectionRatio) best = entry;
        });
        if (best) {
          const index = Number(best.target.dataset.index);
          if (!Number.isNaN(index)) setActiveIndex(index);
        }
      },
      { root: track, threshold: [0.6] },
    );
    Array.prototype.forEach.call(track.children, (slideEl) => intersectionObserver.observe(slideEl));
  }

  function renderSkeleton() {
    mountEl.replaceChildren();
    mountEl.hidden = false;
    const skeleton = document.createElement('div');
    skeleton.className = 'jhs-skeleton';
    mountEl.appendChild(skeleton);
  }

  function renderHidden() {
    // Nothing worth showing (empty API result, or a fetch error) — no fake
    // placeholder slides, no broken box on the homepage. The reason is
    // still logged to the console so the failure is never silently invisible.
    mountEl.replaceChildren();
    mountEl.hidden = true;
  }

  function renderReady() {
    mountEl.hidden = false;
    mountEl.replaceChildren();

    const wrap = document.createElement('div');
    wrap.className = 'jhs-wrap';
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-roledescription', 'carousel');
    wrap.setAttribute('aria-label', 'اسلایدر معرفی جلفا مارکت');

    track = document.createElement('div');
    track.className = 'jhs-track';
    track.setAttribute('tabindex', '0');
    track.setAttribute('aria-label', 'اسلایدهای هیرو؛ برای پیمایش از کلیدهای جهت راست و چپ استفاده کنید');
    // Off while autoplay runs so screen readers aren't interrupted every few
    // seconds; switched to "polite" only while the user has paused rotation
    // (hover/focus/touch below), matching the standard carousel a11y pattern.
    track.setAttribute('aria-live', 'off');

    state.slides.forEach((slide, index) => {
      track.appendChild(createSlideElement(slide, index, state.slides.length));
    });
    wrap.appendChild(track);

    const multiSlide = state.slides.length > 1;

    if (multiSlide) {
      const prevBtn = createArrowElement('prev');
      const nextBtn = createArrowElement('next');
      prevBtn.addEventListener('click', () => goToIndex(state.activeIndex - 1));
      nextBtn.addEventListener('click', () => goToIndex(state.activeIndex + 1));
      wrap.appendChild(prevBtn);
      wrap.appendChild(nextBtn);

      dotsWrap = document.createElement('div');
      dotsWrap.className = 'jhs-dots';
      dotsWrap.setAttribute('role', 'tablist');
      dotsWrap.setAttribute('aria-label', 'انتخاب اسلاید');
      state.slides.forEach((_, index) => dotsWrap.appendChild(createDotElement(index)));
      dotsWrap.addEventListener('click', (event) => {
        const dot = event.target.closest('.jhs-dot');
        if (!dot) return;
        goToIndex(Number(dot.dataset.index));
      });
      wrap.appendChild(dotsWrap);
    } else {
      dotsWrap = null;
    }

    mountEl.appendChild(wrap);
    setupObserver();
    setActiveIndex(0);

    // Pause on hover (desktop) and pause on touch (mobile), matching the
    // requirements; native scroll-snap already provides swipe for free, so
    // there is no custom touch-drag math here at all.
    wrap.addEventListener('mouseenter', clearAutoplay);
    wrap.addEventListener('mouseleave', startAutoplay);
    wrap.addEventListener(
      'touchstart',
      () => {
        isPointerDown = true;
        clearAutoplay();
      },
      { passive: true },
    );
    wrap.addEventListener(
      'touchend',
      () => {
        isPointerDown = false;
        startAutoplay();
      },
      { passive: true },
    );
    wrap.addEventListener('focusin', clearAutoplay);
    wrap.addEventListener('focusout', startAutoplay);
    track.addEventListener('keydown', (event) => {
      // RTL layout: the visual "previous" direction is to the right.
      if (event.key === 'ArrowRight') { event.preventDefault(); goToIndex(state.activeIndex - 1); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); goToIndex(state.activeIndex + 1); }
      else if (event.key === 'Home') { event.preventDefault(); goToIndex(0); }
      else if (event.key === 'End') { event.preventDefault(); goToIndex(state.slides.length - 1); }
    });

    startAutoplay();
  }

  function render() {
    clearAutoplay();
    teardownObserver();
    track = null;
    dotsWrap = null;

    if (state.status === 'loading') renderSkeleton();
    else if (state.status === 'ready') renderReady();
    else renderHidden(); // 'empty' and 'error' both resolve to "show nothing"
  }

  async function load() {
    state.status = 'loading';
    state.slides = [];
    state.activeIndex = 0;
    render();

    try {
      const slides = await fetchHeroSlides();
      state.slides = slides;
      state.status = slides.length > 0 ? 'ready' : 'empty';
      if (slides.length > 0) applyFirstSlidePreload(slides);
      else if (preloadLinkEl) { preloadLinkEl.remove(); preloadLinkEl = null; }
    } catch (err) {
      state.slides = [];
      state.status = 'error';
      if (preloadLinkEl) { preloadLinkEl.remove(); preloadLinkEl = null; }
      // Visible in devtools instead of silently vanishing, unlike the old
      // engine's empty catch block.
      console.error('[HeroSlider] failed to load hero slides:', err);
    }
    render();
  }

  load();

  return {
    reload: load,
    /** Full teardown: stops autoplay, disconnects the observer, removes the
     *  preload hint, and empties the mount. Not required by the current host
     *  page (the mount lives for the page's lifetime), but keeps this
     *  instance leak-free if a caller ever unmounts it (e.g. an SPA route
     *  change in the future) without needing a page reload. */
    destroy() {
      clearAutoplay();
      teardownObserver();
      if (preloadLinkEl) { preloadLinkEl.remove(); preloadLinkEl = null; }
      mountEl.replaceChildren();
    },
  };
}
