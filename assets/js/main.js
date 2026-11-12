// The page: smooth scrolling (Lenis), the chapters that turn the 3D
// controller (GSAP ScrollTrigger), and the text reveals. Everything the
// page says is in the HTML, for search engines and screen readers; the 3D
// only illustrates it.

import { Stage } from './stage.js';

const { gsap, ScrollTrigger, Lenis } = window;
gsap.registerPlugin(ScrollTrigger);

const root = document.documentElement;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const wide = () => innerWidth >= 900;
const navHeight = () => document.querySelector('.nav')?.offsetHeight ?? 64;

// MARK: Smooth scrolling

let lenis = null;
if (!reduceMotion) {
  lenis = new Lenis({ lerp: 0.11, wheelMultiplier: 0.9 });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
}

for (const link of document.querySelectorAll('a[href^="#"]')) {
  link.addEventListener('click', (event) => {
    const target = document.querySelector(link.getAttribute('href'));
    if (!target) return;
    event.preventDefault();
    if (lenis) lenis.scrollTo(target, { offset: -navHeight() });
    else target.scrollIntoView();
    history.replaceState(null, '', link.getAttribute('href'));
  });
}

// MARK: The 3D controller

const canvas = document.querySelector('#stage');
let stage = null;
try {
  stage = new Stage(canvas, {
    reduceMotion,
    // Where the model is framed: the right of the page on a wide window,
    // the upper half on a narrow one, like the app's free area.
    frame: () => wide()
      ? { x: innerWidth * 0.42, y: navHeight(), width: innerWidth * 0.58, height: innerHeight - navHeight() }
      : { x: 0, y: navHeight(), width: innerWidth, height: innerHeight * 0.48 },
  });
  window.__stage = stage;
  stage.load(new URL('../model/dualsense.glb', import.meta.url).href)
    .then(() => root.classList.add('stage-ready'))
    .catch(() => root.classList.add('no-stage'));
} catch {
  root.classList.add('no-stage');
}

if (stage) {
  addEventListener('pointermove', (event) => {
    stage.setPointer(event.clientX / innerWidth * 2 - 1, event.clientY / innerHeight * 2 - 1);
  }, { passive: true });

  const showChapter = (section) => {
    stage.show(section.dataset.pose);
    stage.play(section.dataset.effect ?? null);
    for (const dot of document.querySelectorAll('.progress a')) {
      dot.classList.toggle('active', dot.getAttribute('href') === `#${section.id}`);
    }
  };
  // A section shows its pose and plays its effect while it holds the
  // middle of the screen.
  const followVertically = (section) => ScrollTrigger.create({
    trigger: section,
    start: 'top 55%',
    end: 'bottom 55%',
    onToggle: (self) => { if (self.isActive) showChapter(section); },
  });
  for (const section of document.querySelectorAll('[data-pose]:not(.chapter)')) followVertically(section);

  const chapters = [...document.querySelectorAll('.story .chapter')];
  const media = gsap.matchMedia();
  media.add('(min-width: 900px)', () => {
    const triggers = chapters.map(followVertically);
    return () => triggers.forEach((trigger) => trigger.kill());
  });
  // On a phone the story is pinned and its chapters slide sideways, one
  // per screen of scrolling, snapping to each: the card stays in the lower
  // half and never runs over the controller.
  media.add('(max-width: 899px)', () => {
    const story = document.querySelector('.story');
    const track = document.querySelector('.story-track');
    const dots = [...document.querySelectorAll('.story-dots span')];
    const last = chapters.length - 1;
    let shown = -1;
    const tween = gsap.to(track, {
      x: () => -(track.scrollWidth - innerWidth),
      ease: 'none',
      scrollTrigger: {
        trigger: story,
        pin: true,
        start: 'top top',
        end: () => `+=${innerHeight * last}`,
        scrub: reduceMotion ? true : 0.4,
        snap: { snapTo: 1 / last, duration: { min: 0.15, max: 0.45 }, ease: 'power2.inOut' },
        invalidateOnRefresh: true,
        onUpdate: (self) => {
          const index = Math.round(self.progress * last);
          if (index === shown) return;
          shown = index;
          showChapter(chapters[index]);
          dots.forEach((dot, i) => dot.classList.toggle('active', i === index));
        },
        onEnter: () => showChapter(chapters[Math.max(shown, 0)]),
        onEnterBack: () => showChapter(chapters[Math.max(shown, 0)]),
      },
    });
    // The texts that scroll by vertically fade before they reach the
    // controller.
    // Measured from where each section fills the screen, so a long text
    // that starts near the controller is not faded at load.
    const fades = [...document.querySelectorAll('.hero, .download')].map((section) =>
      gsap.to(section.querySelector('.copy'), {
        opacity: 0, ease: 'none',
        scrollTrigger: { trigger: section, start: 'top top', end: () => `+=${innerHeight * 0.22}`, scrub: true },
      }));
    return () => { tween.scrollTrigger?.kill(); tween.kill(); fades.forEach((fade) => { fade.scrollTrigger?.kill(); fade.kill(); }); };
  });

  // Past the story the page covers the stage, which stops drawing.
  const end = document.querySelector('#faq');
  if (end) {
    ScrollTrigger.create({
      trigger: end,
      start: 'top top',
      onEnter: () => stage.setVisible(false),
      onLeaveBack: () => stage.setVisible(true),
    });
  }
}

// MARK: Reveals

if (!reduceMotion) {
  gsap.from('.hero .reveal', { opacity: 0, y: 28, duration: 0.9, ease: 'power3.out', stagger: 0.09, delay: 0.1 });
  for (const element of document.querySelectorAll('main > section:not(.hero) .reveal')) {
    gsap.from(element, {
      opacity: 0, y: 32, duration: 0.8, ease: 'power3.out',
      scrollTrigger: { trigger: element, start: 'top 88%', once: true },
    });
  }
}
