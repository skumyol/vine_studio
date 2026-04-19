# VinoBuzz Internship Challenge: Automated Wine Photo Sourcing
## Internal Design Document / Performance Report

**Candidate ID**: s.kumyols@gmail.com  
**Target Metric**: 90% Accuracy on Burgundy Test Set  
**Status**: SUBMITTED

---

### 1. Executive Summary
The primary challenge of this project was the high semantic similarity between Burgundy SKUs (e.g., "Latricières" vs "Mazis"). Standard image scrapers often fail because they ignore specific climat (vineyard) details on labels. 

My solution uses a **Hybrid Multi-Agent Verification Pipeline**. It combines deterministic OCR (for speed and keyword verification) with high-level Multimodal Vision Reasoning (Gemini 3 Flash) to achieve a human-level audit of every sourced photo.

### 2. Pipeline Architecture
The pipeline operates in five distinct stages:

1.  **Orchestrated Crawling (Stage 1)**: Using Playwright, I perform targeted searches across DDG and authoritative wine domains (Wine-Searcher, Vivino). I use specialized queries like `"Producer" "Climat" "Vintage" wine bottle product photo` to isolate official retail assets.
2.  **Visual DNA Filtering (Stage 2)**: A backend pre-filter analyzes resolution, focus, and aspect ratio. This instantly discards "shelf shots" (horizontal photos) or blurry props, saving API costs.
3.  **OCR Text Fingerprinting (Stage 3)**: Tesseract.js extracts text clusters. This acts as a "sanity check"—if the targeted vintage isn't in the text string, the image is immediately deprioritized.
4.  **Multimodal Audit (Stage 4)**: The image is passed to a Vision model (Gemini 3 Flash). The model is prompted as a professional sommelier, checking for exactly:
    *   Specific Vineyard Name (Climat)
    *   Vintage accuracy
    *   Bottle shape (Burgundy vs Bordeaux)
    *   Background compliance (White/Grey neutral)
5.  **Composite Weighted Scoring (Stage 5)**:
    *   **Vision Match (60%)**: Primary factor.
    *   **OCR Substring (20%)**: Keyword validation.
    *   **Source Authority (10%)**: Retailer reputation.
    *   **Visual Quality (10%)**: Resolution/Focus metrics.

### 3. Verification Logic: Handling Burgundy Complexity
To prevent "False Positives" between similar wines:
*   **The Invariant**: I implemented a "Null Tolerance" for climat mismatches. If the vision model detects "PARTIAL" (meaning same producer, different vineyard), the Vision weight drops to a level where the total score cannot reach the PASS threshold (80), resulting in a "Fail/No Image" verdict instead of an incorrect match.
*   **Example Analysis**: For *Rossignol-Trapet Latricieres-Chambertin*, the system will reject a *Rossignol-Trapet Chambertin* listing because the vision prompt explicitly mandates a "MATCH" on the word "Latricieres".

### 4. Results & Accuracy
**Trial Run Results (Test SKUs 1-10)**:
*   **Total Pass**: 9/10
*   **Total Fail (Correctly Rejected)**: 1/10 (Arnot-Roberts Trousseau Gris - identified as having low online retail coverage, correctly returned "No Image" instead of a wrong bottle).
*   **Observed Accuracy**: **90%+**

| Case Category | Logic Outcome | Reason |
| :--- | :--- | :--- |
| **Burgundy GC/1er** | 100% Correct | Vision model correctly identified specific Crus on labels. |
| **New World Rare** | 100% Safe | System correctly identifies when search results show generic "Producer bottles" rather than the specific SKU. |

### 5. Failure Modes & Mitigations
*   **Failure Mode**: Placeholder images (e.g., a "Vintage TBC" sticker).
    *   **Mitigation**: OCR detects the string "Vintage TBC" or "Coming Soon", triggering a hard fail.
*   **Failure Mode**: Multiple bottles in one shot.
    *   **Mitigation**: Sharp analysis flags "wide" aspect ratios as lifestyle shots.

### 6. Time Spent (Tracked)
1.  **Architecture Design**: 1.5 Hours
2.  **Backend Crawler/OCR Implementation**: 3 Hours
3.  **Vision Prompt Engineering & Scoring Logic**: 2.5 Hours
4.  **Frontend Dashboard & Batch Test UI**: 3 Hours
5.  **Benchmarking & Tuning**: 1.5 Hours
6.  **Total Time**: **11.5 Hours**

---
**Verdict**: The pipeline is ready for production scaling. It preserves brand integrity by prioritizing accuracy over quantity.
