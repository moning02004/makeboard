/** 색은 src/index.css 의 CSS 변수(RGB 채널)로 정의한다. 다크 모드는 변수만 바뀐다. */
const tokens = ['bg', 'canvas', 'panel', 'hover', 'line', 'edge', 'fg', 'muted', 'faint', 'accent', 'accentsoft', 'onaccent', 'ok', 'fail', 'warn', 'path']

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: Object.fromEntries(tokens.map((k) => [k, `rgb(var(--${k}) / <alpha-value>)`])),
      fontFamily: {
        // 테마마다 본문 글꼴이 다르다 (다크: 일반 글꼴, 라이트: 고정폭). index.css 의 --font-body
        sans: ['var(--font-body)'],
        mono: ['"JetBrains Mono"', '"Nanum Gothic Coding"', 'ui-monospace', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
