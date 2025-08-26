import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const posts = defineCollection({
	// Load Markdown and MDX files in the `src/content/posts/` directory.
	loader: glob({ base: './src/content/posts', pattern: '**/*.{md,mdx}' }),
	// Type-check frontmatter using a schema
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			author: z.string(),
			// Transform string to Date object, supporting DD.MM.YYYY format
			pubDate: z.string().transform((str) => {
				// Check if it's in DD.MM.YYYY format
				if (/^\d{2}\.\d{2}\.\d{4}$/.test(str)) {
					const [day, month, year] = str.split('.');
					return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
				}
				// Fallback to default date parsing
				return new Date(str);
			}),
			updatedDate: z.coerce.date().optional(),
			heroImage: image().optional(),
			tags: z.array(z.string()).optional(),
			showRevisionHistory: z.boolean().optional().default(true),
		}),
});

export const collections = { posts };
