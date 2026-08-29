import sys
import os
import json
import torch
import numpy as np
import librosa
import soundfile as sf
import typing

def separate_vocals(input_path, output_instrumental_path):
    try:
        print("[SEP] Loading Open-Unmix model (umxhq)...", file=sys.stderr)
        
        # CPU processing
        device = torch.device('cpu')
            
        # Load model using torch.hub
        separator: typing.Any = torch.hub.load('sigsep/open-unmix-pytorch', 'umxhq', device=device)
        
        print("[SEP] Loading audio and resampling...", file=sys.stderr)
        # Load audio and automatically resample to separator's required sample rate
        # mono=False ensures we preserve channels
        audio, sample_rate = librosa.load(input_path, sr=separator.sample_rate, mono=False)
        
        # Ensure stereo (2 channels)
        if audio.ndim == 1:
            audio = np.stack([audio, audio], axis=0)
        elif audio.shape[0] > 2:
            audio = audio[:2, :]
            
        audio_tensor = torch.from_numpy(audio).float()
        audio_batch = audio_tensor.unsqueeze(0).to(device)
        
        print("[SEP] Separating audio stems in chunks to save RAM...", file=sys.stderr)
        
        import gc
        del audio
        gc.collect()
        
        # Chunk size: 10 seconds
        chunk_size = int(10 * separator.sample_rate)
        total_samples = audio_batch.shape[-1]
        
        drums_chunks = []
        bass_chunks = []
        other_chunks = []
        
        with torch.no_grad():
            for i in range(0, total_samples, chunk_size):
                end = min(i + chunk_size, total_samples)
                chunk = audio_batch[:, :, i:end]
                
                # Estimates shape: [1, 4, channels, samples]
                # order: [vocals, drums, bass, other]
                estimates = separator(chunk)
                
                drums_chunks.append(estimates[0, 1].cpu())
                bass_chunks.append(estimates[0, 2].cpu())
                other_chunks.append(estimates[0, 3].cpu())
                
                # Free memory after each chunk
                del chunk
                del estimates
                gc.collect()
                    
        print("[SEP] Combining non-vocal stems to create instrumental accompaniment...", file=sys.stderr)
        drums = torch.cat(drums_chunks, dim=-1)
        bass = torch.cat(bass_chunks, dim=-1)
        other = torch.cat(other_chunks, dim=-1)
        
        instrumental = drums + bass + other
        
        # Clean up memory
        del drums_chunks, bass_chunks, other_chunks, drums, bass, other
        gc.collect()
        
        print(f"[SEP] Saving instrumental to: {output_instrumental_path}", file=sys.stderr)
        # Create directories if they do not exist
        os.makedirs(os.path.dirname(output_instrumental_path), exist_ok=True)
        
        # soundfile.write expects shape (samples, channels)
        instrumental_np = instrumental.numpy().T
        sf.write(output_instrumental_path, instrumental_np, separator.sample_rate)
        
        print(json.dumps({"success": True, "output_path": output_instrumental_path}))
    except Exception as e:
        import traceback
        err_msg = str(e) + "\n" + traceback.format_exc()
        print(json.dumps({"error": err_msg}))

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Missing input_path or output_path argument"}))
        sys.exit(1)
    separate_vocals(sys.argv[1], sys.argv[2])
