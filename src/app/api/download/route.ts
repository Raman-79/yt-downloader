import { spawn } from 'child_process';
import path from 'path';
import { promises as fs } from 'fs';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NextResponse } from 'next/server';
import crypto from 'crypto';

// Enhanced URL Validation Function
function validateYouTubeURL(url: string): boolean {
  const youtubeUrlPatterns = [
    /^(https?:\/\/)?(www\.)?(youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /^https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([^&]+)/,
    /^https?:\/\/(?:www\.)?youtu\.be\/([^?&]+)/,
    /^https?:\/\/(?:www\.)?youtube\.com\/embed\/([^?&]+)/
  ];

  return youtubeUrlPatterns.some(pattern => pattern.test(url));
}

// Input Sanitization Function
function sanitizeInput(input: string): string {
  return input.replace(/[;&|><*?`$()[\]#!]/g, '');
}

// Error Tracking Function
function generateErrorTrackingId(): string {
  return crypto.randomBytes(16).toString('hex');
}

// Environment Variables Validation Function
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

// File Size Validation Function
async function validateFileSize(
  filePath: string, 
  maxSizeInBytes: number = 100 * 1024 * 1024
): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size <= maxSizeInBytes;
  } catch (error) {
    console.error('File size validation error:', error);
    return false;
  }
}

export async function POST(req: Request) {
  try {
    // Validate environment configuration
    validateEnvVariables();

    // Parse request body
    const body = await req.json();
    const { url, format, id } = body;

    // Enhanced URL Validation
    if (!url || !validateYouTubeURL(url)) {
      return NextResponse.json({ 
        error: 'Invalid YouTube URL', 
        details: 'Please provide a valid YouTube video URL' 
      }, { status: 400 });
    }

    // Sanitize inputs
    const sanitizedId = sanitizeInput(id);

    // Prepare file paths and S3 configuration
    const downloadsDir = path.resolve('./public/downloads');
    const s3BucketName = process.env.AWS_BUCKET_NAME!;
    const s3Key = `${sanitizedId}.${format === 'audio' ? 'mp3' : 'webm'}`;

    // Configure S3 Client
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

      return NextResponse.json({ 
        message: 'File available in S3', 
        presignedUrl 
      });
    } catch  {
      // File not in S3, continue with download process
      console.log('File not found in S3, proceeding with download');
    }

    // Create downloads directory if it doesn't exist
    await fs.mkdir(downloadsDir, { recursive: true });

    // Detailed download promise with robust error handling
    const downloadResult = await new Promise<{ filePath: string }>((resolve, reject) => {
      const outputTemplate = path.join(downloadsDir, `${sanitizedId}.%(ext)s`);
      const downloadOptions = format === 'audio'
        ? ['-x', '--audio-format', 'mp3', '-o', outputTemplate, url]
        : ['-f', 'bestaudio+bestvideo', '-o', outputTemplate, url];

      const process = spawn('yt-dlp', downloadOptions);
      
      let output = '';
      let errorOutput = '';

      process.stdout.on('data', (data) => {
        output += data.toString();
      });

      process.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      process.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Download failed. 
            Exit Code: ${code}
            Output: ${output}
            Error: ${errorOutput}`));
          return;
        }

        // Extract file path from output
        const match = format === 'video'
          ? output.match(/\[Merger\] Merging formats into "(.*?)"/)
          : output.match(/\[ExtractAudio\] Destination: (.+)/);
       
        const downloadedFilePath = match ? match[1].trim() : null;
        console.log(downloadedFilePath)
        if (!downloadedFilePath) {
          reject(new Error('Failed to retrieve downloaded file path'));
          return;
        }

        resolve({ filePath: downloadedFilePath });
      });
    });

    // Validate file path exists and is not null
    const localPath = downloadResult.filePath;
    if (!localPath) {
      return NextResponse.json({ 
        error: 'Download failed', 
        details: 'Unable to locate downloaded file' 
      }, { status: 500 });
    }

    // Validate file size
    const isFileSizeValid = await validateFileSize(localPath);
    if (!isFileSizeValid) {
      await fs.unlink(localPath);
      return NextResponse.json({ 
        error: 'File size exceeds limit', 
        details: 'The downloaded file is too large' 
      }, { status: 413 });
    }

    // Upload to S3
    const fileStream = await fs.readFile(localPath);
    await s3.send(
      new PutObjectCommand({
        Bucket: s3BucketName,
        Key: s3Key,
        Body: fileStream,
        ContentType: format === 'audio' ? 'audio/mpeg' : 'video/webm',
      })
    );

    // Generate presigned URL
    const presignedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: s3BucketName, Key: s3Key }),
      { expiresIn: 3600 }
    );

    // Clean up local file
    await fs.unlink(localPath);

    return NextResponse.json({ 
      message: 'File downloaded and uploaded to S3', 
      presignedUrl 
    });

  } catch (error) {
    const errorId = generateErrorTrackingId();
    console.error(`Download processing error [${errorId}]:`, error);

    return NextResponse.json({ 
      error: 'Download failed', 
      errorId: errorId,
      details: error instanceof Error ? error.message : 'Unknown error occurred'
    }, { status: 500 });
  }
}