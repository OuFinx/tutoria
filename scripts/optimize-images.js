#!/usr/bin/env node

import sharp from 'sharp';
import { readdir, stat } from 'fs/promises';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ASSETS_DIR = join(__dirname, '../src/assets');

// Optimization settings
const JPEG_QUALITY = 85;
const PNG_COMPRESSION = 9;
const WEBP_QUALITY = 80;

async function getImageFiles(dir) {
    const files = [];
    const entries = await readdir(dir);

    for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stats = await stat(fullPath);

        if (stats.isFile()) {
            const ext = extname(entry).toLowerCase();
            if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
                files.push(fullPath);
            }
        }
    }

    return files;
}

async function optimizeImage(imagePath) {
    const ext = extname(imagePath).toLowerCase();
    const originalStats = await stat(imagePath);
    const originalSize = originalStats.size;

    console.log(`📸 Optimizing: ${imagePath}`);

    let sharpInstance = sharp(imagePath);

    switch (ext) {
        case '.jpg':
        case '.jpeg':
            sharpInstance = sharpInstance.jpeg({
                quality: JPEG_QUALITY,
                progressive: true,
                mozjpeg: true
            });
            break;

        case '.png':
            sharpInstance = sharpInstance.png({
                compressionLevel: PNG_COMPRESSION,
                progressive: true
            });
            break;

        case '.webp':
            sharpInstance = sharpInstance.webp({
                quality: WEBP_QUALITY
            });
            break;
    }

    await sharpInstance.toFile(imagePath + '.tmp');

    // Replace original with optimized version
    const { rename, unlink } = await import('fs/promises');
    await unlink(imagePath);
    await rename(imagePath + '.tmp', imagePath);

    const newStats = await stat(imagePath);
    const newSize = newStats.size;
    const savings = ((originalSize - newSize) / originalSize * 100).toFixed(2);

    console.log(`✅ ${imagePath}`);
    console.log(`   Original: ${(originalSize / 1024).toFixed(2)} KB`);
    console.log(`   Optimized: ${(newSize / 1024).toFixed(2)} KB`);
    console.log(`   Savings: ${savings}%\n`);

    return {
        file: imagePath,
        originalSize,
        newSize,
        savings: parseFloat(savings)
    };
}

async function main() {
    console.log('🚀 Starting image optimization...\n');

    try {
        const imageFiles = await getImageFiles(ASSETS_DIR);

        if (imageFiles.length === 0) {
            console.log('No images found in assets directory.');
            return;
        }

        console.log(`Found ${imageFiles.length} images to optimize\n`);

        const results = [];
        let totalOriginalSize = 0;
        let totalNewSize = 0;

        for (const imagePath of imageFiles) {
            try {
                const result = await optimizeImage(imagePath);
                results.push(result);
                totalOriginalSize += result.originalSize;
                totalNewSize += result.newSize;
            } catch (error) {
                console.error(`❌ Failed to optimize ${imagePath}:`, error.message);
            }
        }

        // Summary
        const totalSavings = ((totalOriginalSize - totalNewSize) / totalOriginalSize * 100).toFixed(2);

        console.log('📊 OPTIMIZATION SUMMARY');
        console.log('========================');
        console.log(`Images processed: ${results.length}`);
        console.log(`Total original size: ${(totalOriginalSize / 1024).toFixed(2)} KB`);
        console.log(`Total optimized size: ${(totalNewSize / 1024).toFixed(2)} KB`);
        console.log(`Total savings: ${totalSavings}%`);
        console.log(`Space saved: ${((totalOriginalSize - totalNewSize) / 1024).toFixed(2)} KB`);

        console.log('\n✨ Image optimization complete!');

    } catch (error) {
        console.error('❌ Error during optimization:', error.message);
        process.exit(1);
    }
}

main();
