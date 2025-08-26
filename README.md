# Tutoria 📚

Tutoria is a collection of HowTo tutorials created to address the gap between theoretical documentation and practical implementation. The blog emphasizes:

- **Clear, practical guides** with real-world examples
- **Visual learning** through screenshots and diagrams
- **Step-by-step instructions** that actually work
- **Open-source collaboration** - contributions welcome!

## ✨ Features

- ✅ **100/100 Lighthouse performance** - Lightning fast loading
- ✅ **SEO-optimized** with canonical URLs and OpenGraph data
- ✅ **Search functionality** powered by Pagefind
- ✅ **RSS Feed support** for easy subscription
- ✅ **Sitemap generation** for better discoverability
- ✅ **Markdown & MDX support** for rich content
- ✅ **Git revision history** tracking for content updates
- ✅ **Responsive design** that works on all devices
- ✅ **Dark/light theme** support

## 🚀 Tech Stack

- **Framework**: [Astro](https://astro.build/) - The modern web framework
- **Styling**: Custom CSS with CSS variables
- **Search**: [Pagefind](https://pagefind.app/) - Static search engine
- **Content**: Markdown with frontmatter
- **Deployment**: Vercel-ready with `vercel.json`
- **Image optimization**: Sharp for automatic image processing

## 📁 Project Structure

```
├── public/                 # Static assets (fonts, favicon)
├── src/
│   ├── assets/            # Images and media files
│   ├── components/        # Reusable Astro components
│   │   ├── BaseHead.astro
│   │   ├── Comments.astro
│   │   ├── Footer.astro
│   │   ├── Header.astro
│   │   ├── HeaderSearch.astro
│   │   ├── RevisionHistory.astro
│   │   └── Search.astro
│   ├── content/
│   │   └── posts/         # Blog posts in Markdown
│   ├── layouts/           # Page layouts
│   │   ├── BlogPost.astro
│   │   └── PostLayout.astro
│   ├── pages/             # Route pages
│   │   ├── index.astro    # Homepage
│   │   ├── posts/         # Blog post pages
│   │   ├── search.astro   # Search page
│   │   └── rss.xml.js     # RSS feed
│   ├── styles/
│   │   └── global.css     # Global styles
│   └── utils/
│       └── git-history.ts # Git revision tracking
├── scripts/
│   └── optimize-images.js # Image optimization script
├── astro.config.mjs       # Astro configuration
├── content.config.ts      # Content collection schema
└── vercel.json            # Vercel deployment config
```

## 🛠️ Development

### Prerequisites

- Node.js 18+
- npm or yarn

### Setup

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd tutoria
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start development server**
   ```bash
   npm run dev
   ```
   Open [http://localhost:4321](http://localhost:4321) to view the site.

### Available Scripts

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm run dev`             | Start local dev server at `localhost:4321`      |
| `npm run build`           | Build production site to `./dist/`              |
| `npm run preview`         | Preview production build locally                 |
| `npm run optimize-images` | Optimize images in the assets folder            |
| `npm run astro ...`       | Run Astro CLI commands                          |

## 📝 Writing Posts

1. **Create a new post** in `src/content/posts/`
2. **Use the frontmatter template**:
   ```yaml
   ---
   title: 'Your Tutorial Title'
   description: 'Brief description of what this tutorial covers'
   author: 'Your Name'
   pubDate: 'DD.MM.YYYY'
   heroImage: '../../assets/your-image.png'
   tags: ['Tag1', 'Tag2']
   ---
   ```
3. **Include screenshots** in `src/assets/` and reference them
4. **Test locally** with `npm run dev`

## 🎨 Customization

### Site Configuration
Update `src/consts.ts` for site-wide settings:
```typescript
export const SITE_TITLE = 'Tutoria';
export const SITE_DESCRIPTION = 'Your site description';
```

### Styling
- Global styles: `src/styles/global.css`
- Component styles: Inline `<style>` blocks in `.astro` files
- CSS variables for consistent theming

### Adding Features
- **Search**: Already configured with Pagefind
- **Comments**: Disqus integration available in `Comments.astro`
- **Analytics**: Add your tracking code to `BaseHead.astro`

## 🚀 Deployment

### Vercel (Recommended)
1. Connect your GitHub repository to Vercel
2. Vercel will automatically detect Astro and deploy
3. Custom domain can be configured in Vercel dashboard

### Other Platforms
The site is static and can be deployed to:
- Netlify
- GitHub Pages
- Cloudflare Pages
- Any static hosting service

## 🤝 Contributing

This blog is open-source! Contributions are welcome:

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-tutorial`
3. **Write your tutorial** with clear examples and screenshots
4. **Test locally**: `npm run dev`
5. **Commit changes**: `git commit -m 'Add amazing tutorial'`
6. **Push to branch**: `git push origin feature/amazing-tutorial`
7. **Open a Pull Request**

### Guidelines
- Follow the existing post structure and frontmatter format
- Include clear, step-by-step instructions
- Add relevant screenshots and diagrams
- Test all code examples
- Update this README if adding new features

## 📄 License

This project is open source and available under the [MIT License](LICENSE).

---

**Happy learning!** 🚀 If you find these tutorials helpful, consider starring the repository or sharing with others.

*P.S. Yes, you can find the cursor generated code here, don't blame me*🙃