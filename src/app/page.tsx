'use client';

import { Input } from "@/components/ui/input";
import { useState } from "react";
import { Button } from "@/components/ui/button";
//@ts-expect-error abc
import * as youtubeUrl from 'youtube-url';


export default function Home() {
  const [url, setUrl] = useState("");
  const [toggle, setToggle] = useState(false);
  const [imageUrl, setImageUrl] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  // Enhanced URL Validation
  const isValidYouTubeURL = (inputUrl: string): boolean => {
    return youtubeUrl.valid(inputUrl);
  };

  // Handler for paste event with improved validation
  const pasteHandler = (event: React.ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const pastedData = event.clipboardData?.getData("text");
    
    if (pastedData && isValidYouTubeURL(pastedData)) {
      setUrl(pastedData);
      const youtube_id = youtubeUrl.extractId(pastedData);
      setImageUrl(`https://img.youtube.com/vi/${youtube_id}/hqdefault.jpg`);
      setToggle(true);
      setStatus(""); // Clear any previous error messages
    } else {
      setStatus("Invalid YouTube URL. Please check and try again.");
      setToggle(false);
    }
  };

  // Enhanced download handler with additional validation
  const downloadHandler = async (format: string) => {
    // Reset states
    setLoading(true);
    setStatus("");

    // Comprehensive input validation
    if (!url.trim()) {
      setStatus("Please enter a valid YouTube URL");
      setLoading(false);
      return;
    }

    if (!isValidYouTubeURL(url)) {
      setStatus("Invalid YouTube URL format");
      setLoading(false);
      return;
    }

    try {
      const id = youtubeUrl.extractId(url);
      const res = await fetch("/api/download", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          // Optional: Add CSRF token if implemented
          // "X-CSRF-Token": csrfToken 
        },
        body: JSON.stringify({ url, format, id }),
      });

      const data = await res.json();
      if (res.ok) {
        const { presignedUrl } = data;
        // Use window.open for more control over download
        window.location.href = presignedUrl;
      } else {
        // Enhanced error handling
        const errorMessage = data.error || 'An unknown error occurred';
        setStatus(`Download failed: ${errorMessage}`);
        
        // Optional: Log error to your analytics/monitoring system
        console.error('Download Error:', data);
      }
    } catch (err) {
      const errorMessage = (err as Error).message || 'Network error';
      setStatus(`Failed to process download: ${errorMessage}`);
      
      // Optional: Log detailed error
      console.error('Download Error:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8 bg-gradient-to-br from-gray-800 to-black text-white">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-bold text-center mb-6">YouTube Downloader</h1>
        <Input
          type="url"
          placeholder="Paste YouTube Video URL"
          value={url}
          onPasteCapture={pasteHandler}
          onChange={(e) => {
            setUrl(e.target.value);
            // Optional: Live validation as user types
            if (!isValidYouTubeURL(e.target.value)) {
              setToggle(false);
            }
          }}
          className="mb-4 w-full text-gray-800"
        />
        
        {toggle && (
          <div className="flex flex-col items-center mt-6">
            <img
              src={imageUrl}
              alt="Thumbnail"
              className="rounded-lg shadow-lg mb-6 max-w-full"
            />
            <div className="flex gap-4">
              <Button
                variant="outline"
                className="border-2 border-green-500 text-green-500 hover:bg-green-500 hover:text-white"
                onClick={() => downloadHandler("video")}
                disabled={loading} 
              >
                {loading && <span className="loader mr-2"></span>} Download Video
              </Button>
              <Button
                variant="outline"
                className="border-2 border-blue-500 text-blue-500 hover:bg-blue-500 hover:text-white"
                onClick={() => downloadHandler("audio")}
                disabled={loading} 
              >
                {loading && <span className="loader mr-2"></span>} Download Audio
              </Button>
            </div>
          </div>
        )}
      </div>
      
      {loading && (
        <div className="mt-4">
          <span className="loader"></span>
          <p className="text-gray-300">Processing your request...</p>
        </div>
      )}
      
      {status && (
        <p className="mt-4 text-red-500 text-center">
          {status}
        </p>
      )}
    </div>
  );
}