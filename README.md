# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

## External Dependencies

This project relies on several external binaries for media processing. While some may be bundled, others must be present in the system PATH.

### Essential Components

1.  **yt-dlp**: Used for fetching video metadata and downloading.
2.  **ffmpeg / ffprobe**: Required for probing media files and merging video/audio streams during download.
3.  **Deno**: **CRITICAL**. A JavaScript runtime is required for `yt-dlp` to solve YouTube signature challenges. Without this, you will likely encounter `Signature solving failed` or `403 Forbidden` errors.
    *   **Installation (Windows)**: `winget install DenoLand.Deno`

---

## Troubleshooting (YouTube Downloader)

### 1. HTTP Error 429: Too Many Requests / Sign-in Requirement
YouTube frequently blocks automated requests. To bypass this, the app uses:
*   **Extractor Args**: `--extractor-args "youtube:player_client=web_creator,mweb"` to use more permissive API endpoints.
*   **User-Agent**: A modern Chrome user-agent string to mimic browser behavior.

### 2. Signature solving failed
Ensure **Deno** is installed and accessible in your terminal. You can verify this by running `deno --version`. If `yt-dlp` cannot find a JS runtime, it cannot decrypt YouTube's playback tokens.

### 3. Cookies (Optional)
If bot detection persists, you can manually export cookies from your browser to a `.txt` file and pass them to `yt-dlp`, but the current `extractor-args` strategy is generally more stable for general use without requiring local browser file access.

### 4. Failed to decrypt with DPAPI (Windows)
Avoid using `--cookies-from-browser` if the browser (Chrome/Edge) is currently open, as Windows locks the database. The current implementation avoids this by using server-side client strategies.
