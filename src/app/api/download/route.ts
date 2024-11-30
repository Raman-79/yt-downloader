import { spawn } from 'child_process';
import path from 'path';
import { promises as fs } from 'fs';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NextResponse } from 'next/server';
import crypto from 'crypto';

// Enhanced URL Validation
function validateYouTubeURL(url: string): boolean {
  const youtubeUrlPatterns = [
    /^https:\/\/(?:www\.)?youtube\.com\/watch\?v=([^&]+)/,
    /^https:\/\/(?:www\.)?youtu\.be\/([^?&]+)/,
    /^https:\/\/(?:www\.)?youtube\.com\/embed\/([^?&]+)/
  ];

  return youtubeUrlPatterns.some(pattern => pattern.test(url));
}

// Input Sanitization
function sanitizeInput(input: string): string {
  return input.replace(/[;&|><*?`$()[\]#!]/g, '');
}

// Error Tracking
function generateErrorTrackingId(): string {
  return crypto.randomBytes(16).toString('hex');
}

// Environment Variables Validation
function validateEnvVariables() {
  const requiredVars = [
    'AWS_REGION', 
    'AWS_ACCESS_KEY_ID', 
    'AWS_SECRET_ACCESS_KEY', 
    'AWS_BUCKET_NAME'
  ];

  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      throw new Error(`Missing required environment variable: ${varName}`);
    }
  }
}

// File Size Validation
async function validateFileSize(filePath: string, maxSizeInBytes: number = 100 * 1024 * 1024): Promise<boolean> {
  const stats = await fs.stat(filePath);
  return stats.size <= maxSizeInBytes;
}

export async function POST(req: Request) {
  try {
    // Validate environment configuration
    validateEnvVariables();

    const body = await req.json();
    const { url, format, id } = body;

    // Enhanced URL Validation
    if (!url || !validateYouTubeURL(url)) {
      return NextResponse.json({ error: 'Invalid YouTube URL' }, { status: 400 });
    }

    // Sanitize inputs
    const sanitizedUrl = sanitizeInput(url);
    const sanitizedId = sanitizeInput(id);

    const downloadsDir = path.resolve('./public/downloads');
    const localFilePath = path.join(
      downloadsDir, 
      `${sanitizedId}.${format === 'audio' ? 'mp3' : 'mp4'}`
    );
    const s3BucketName = process.env.AWS_BUCKET_NAME!;
    const s3Key = `${sanitizedId}.${format === 'audio' ? 'mp3' : 'mp4'}`;

    // S3 Client Configuration with Environment Validation
    const s3 = new S3Client({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });

    // Check if file exists in S3
    try {
      await s3.send(new GetObjectCommand({ Bucket: s3BucketName, Key: s3Key }));
      
      const presignedUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: s3BucketName, Key: s3Key }),
        { expiresIn: 3600 }
      );

      return NextResponse.json({ message: 'File available in S3', presignedUrl });
    } catch {
      // File not in S3, continue with download process
    }

    // Create downloads directory if it doesn't exist
    await fs.mkdir(downloadsDir, { recursive: true });

    // Download using spawn for better security
    const outputTemplate = path.join(downloadsDir, `${sanitizedId}.%(ext)s`);
    const downloadOptions = format === 'audio'
      ? ['-x', '--audio-format', 'mp3', '-o', outputTemplate, sanitizedUrl]
      : ['-f', 'best', '-o', outputTemplate, sanitizedUrl];

    const downloadResult = await new Promise<{ filePath: string }>((resolve, reject) => {
      const process = spawn('yt-dlp', downloadOptions);
      let output = '';

      process.stdout.on('data', (data) => {
        output += data.toString();
      });

      process.stderr.on('data', (data) => {
        output += data.toString();
      });

      process.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Download failed: ${output}`));
        }

        // Extract file path from output
        const match = format === 'video'
          ? output.match(/\[download\] Destination: (.+)/)
          : output.match(/\[ExtractAudio\] Destination: (.+)/);

        const downloadedFilePath = match ? match[1].trim() : null;

        if (!downloadedFilePath) {
          reject(new Error('Failed to retrieve file path'));
        }
        //@ts-expect-error abc
        resolve({ filePath: downloadedFilePath });
      });
    });

    // Validate file size
    const isFileSizeValid = await validateFileSize(downloadResult.filePath);
    if (!isFileSizeValid) {
      await fs.unlink(downloadResult.filePath);
      return NextResponse.json({ error: 'File size exceeds limit' }, { status: 413 });
    }

    // Upload to S3
    const fileStream = await fs.readFile(downloadResult.filePath);
    await s3.send(
      new PutObjectCommand({
        Bucket: s3BucketName,
        Key: s3Key,
        Body: fileStream,
        ContentType: format === 'audio' ? 'audio/mpeg' : 'video/mp4',
      })
    );

    // Generate presigned URL
    const presignedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: s3BucketName, Key: s3Key }),
      { expiresIn: 3600 }
    );

    // Clean up local file
    await fs.unlink(downloadResult.filePath);

    return NextResponse.json({ message: 'File downloaded and uploaded to S3', presignedUrl });

  } catch (error) {
    const errorId = generateErrorTrackingId();
    console.error(`Download processing error [${errorId}]:`, error);

    return NextResponse.json({ 
      error: 'Download failed', 
      errorId: errorId 
    }, { status: 500 });
  }
}