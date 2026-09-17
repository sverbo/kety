// ocr.swift - Vision.framework OCR (macOS 11+)
// Usage: ocr-tool <image_path>
// Stdout: texte extrait, une ligne par bloc détecté.
// Détection automatique de la langue (français, anglais, etc.).

import Vision
import Foundation
import CoreGraphics

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: ocr-tool <image_path>\n", stderr)
    exit(1)
}

let imagePath = CommandLine.arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)

guard FileManager.default.fileExists(atPath: imagePath) else {
    fputs("ocr-tool: fichier introuvable : \(imagePath)\n", stderr)
    exit(1)
}

guard
    let imageSource = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
    let cgImage = CGImageSourceCreateImageAtIndex(imageSource, 0, nil)
else {
    fputs("ocr-tool: impossible de charger l'image : \(imagePath)\n", stderr)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

// Détection automatique de la langue disponible depuis macOS 12.
if #available(macOS 12.0, *) {
    request.automaticallyDetectsLanguage = true
} else {
    // Fallback : liste explicite de langues supportées sur macOS 11.
    request.recognitionLanguages = ["fr-FR", "en-US"]
}

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fputs("ocr-tool: Vision error: \(error.localizedDescription)\n", stderr)
    exit(1)
}

let observations = request.results ?? []
for obs in observations {
    if let candidate = obs.topCandidates(1).first, !candidate.string.isEmpty {
        print(candidate.string)
    }
}
