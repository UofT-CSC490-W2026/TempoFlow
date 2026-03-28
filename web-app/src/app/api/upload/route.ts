import { NextResponse } from 'next/server';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

export async function POST(request: Request) {
  try {
    const { filename, contentType } = await request.json();

    const storageMode = process.env.NEXT_PUBLIC_APP_STORAGE_MODE ?? 'local';
    if (storageMode !== 'aws') {
      return NextResponse.json(
        {
          error: 'Cloud upload is disabled. Set NEXT_PUBLIC_APP_STORAGE_MODE=aws to enable S3 uploads.',
        },
        { status: 400 },
      );
    }

    const region = process.env.AWS_REGION || 'us-east-1';
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const useStaticKeys = Boolean(accessKeyId && secretAccessKey);

    const s3Client = new S3Client({
      region,
      ...(useStaticKeys
        ? {
            credentials: {
              accessKeyId: accessKeyId!,
              secretAccessKey: secretAccessKey!,
            },
          }
        : {}),
    });
    
    const bucketName = process.env.USER_VIDEO_BUCKET_NAME;

    if (!bucketName || bucketName === 'your-user-video-bucket-name') {
      return NextResponse.json({ error: 'Bucket name not configured' }, { status: 500 });
    }

    const { url, fields } = await createPresignedPost(s3Client, {
      Bucket: bucketName,
      Key: `raw/${Date.now()}-${filename}`,
      Conditions: [
        ['content-length-range', 0, 104857600], // up to 100 MB
        ['eq', '$Content-Type', contentType],
      ],
      Fields: {
        'Content-Type': contentType,
      },
      Expires: 600,
    });

    return NextResponse.json({ url, fields });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to create presigned URL' }, { status: 500 });
  }
}
