// Enregistrement écran via Screen Capture Kit + AVAssetWriter (même processus que l’app → TCC cohérent).
// macOS 12.3+ (API SCK). Cible minimale : macOS 12.3.

import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

/// Logs visibles dans le terminal `tauri dev` (stderr), car plusieurs chemins d’échec étaient muets.
private func sckLog(_ msg: String) {
    let line = "[kts:sck-swift] \(msg)\n"
    if let d = line.data(using: .utf8) {
        FileHandle.standardError.write(d)
    }
}

private func copyError(_ msg: String, _ errOut: UnsafeMutablePointer<CChar>?, _ errLen: Int) {
    guard let errOut, errLen > 1 else { return }
    let bytes = Array(msg.utf8)
    let maxCopy = errLen - 1
    let n = min(bytes.count, maxCopy)
    for i in 0..<n {
        errOut[i] = CChar(Int8(bitPattern: bytes[i]))
    }
    errOut[n] = 0
}

private var gRecorder: Recorder?

/// Démarre la capture vers `path` (UTF-8). `displayIndex` = même convention que le HUD (moniteurs triés par origine x puis y).
/// `quality` : 0=low (15fps, ½ résolution, 1.5 Mbps), 1=medium (20fps, ¾ résolution, 4 Mbps), 2=high (30fps, natif).
/// `errOut` / `errLen` : message UTF-8 tronqué si échec (optionnel).
@_cdecl("kts_sck_start")
public func kts_sck_start(
    _ path: UnsafePointer<CChar>?,
    _ displayIndex: UInt32,
    _ quality: UInt32,
    _ errOut: UnsafeMutablePointer<CChar>?,
    _ errLen: Int
) -> Int32 {
    guard let path else {
        copyError("chemin null", errOut, errLen)
        return -1
    }
    let pathStr = String(cString: path)
    sckLog("kts_sck_start path=\(pathStr) displayIndex=\(displayIndex) quality=\(quality)")
    let sem = DispatchSemaphore(value: 0)
    var code: Int32 = 0
    Task {
        do {
            try await Recorder.startRecording(path: pathStr, displayIndex: Int(displayIndex), quality: quality)
            sckLog("startRecording terminé sans throw")
        } catch {
            sckLog("startRecording throw: \(error)")
            copyError(String(describing: error), errOut, errLen)
            code = -1
        }
        sem.signal()
    }
    sem.wait()
    return code
}

/// Met en pause la capture (les frames sont ignorées, le fichier reste ouvert).
@_cdecl("kts_sck_pause")
public func kts_sck_pause(_ errOut: UnsafeMutablePointer<CChar>?, _ errLen: Int) -> Int32 {
    guard let rec = gRecorder else {
        copyError("Aucun enregistrement en cours", errOut, errLen)
        return -1
    }
    rec.pause()
    return 0
}

/// Reprend la capture après une pause.
@_cdecl("kts_sck_resume")
public func kts_sck_resume(_ errOut: UnsafeMutablePointer<CChar>?, _ errLen: Int) -> Int32 {
    guard let rec = gRecorder else {
        copyError("Aucun enregistrement en cours", errOut, errLen)
        return -1
    }
    rec.resume()
    return 0
}

/// Arrête la capture et finalise le fichier MP4.
@_cdecl("kts_sck_stop")
public func kts_sck_stop(_ errOut: UnsafeMutablePointer<CChar>?, _ errLen: Int) -> Int32 {
    sckLog("kts_sck_stop (gRecorder actif: \(gRecorder != nil))")
    let sem = DispatchSemaphore(value: 0)
    var code: Int32 = 0
    Task {
        do {
            try await Recorder.stopRecording()
            sckLog("stopRecording terminé sans throw")
        } catch {
            sckLog("stopRecording throw: \(error)")
            copyError(String(describing: error), errOut, errLen)
            code = -1
        }
        sem.signal()
    }
    sem.wait()
    return code
}

enum KtsSckError: Error {
    case noDisplay
    case writerSetup
}

/// Combine la vidéo MP4 (avec audio système) et un WAV micro en un seul MP4.
// ── Embed mic audio (video stream copy, mic WAV → AAC only) ──────────────────

/// Mixes mic WAV into an existing MP4 using AVAssetReader/Writer passthrough for the
/// video track (no re-encode) and AAC encode only for the mic audio. Much faster than
/// AVAssetExportSession which re-encodes the entire video.
private func embedMicAudio(videoURL: URL, wavURL: URL, outputURL: URL) async throws {
    let videoAsset = AVURLAsset(url: videoURL)
    let micAsset   = AVURLAsset(url: wavURL)

    let videoDuration = try await videoAsset.load(.duration)
    let micDuration   = try await micAsset.load(.duration)
    let mixDur = CMTimeMinimum(videoDuration, micDuration)

    // ── Readers ─────────────────────────────────────────────────────────────
    let reader = try AVAssetReader(asset: videoAsset)
    reader.timeRange = CMTimeRange(start: .zero, duration: videoDuration)

    let videoTracks    = try await videoAsset.loadTracks(withMediaType: .video)
    let sysAudioTracks = try await videoAsset.loadTracks(withMediaType: .audio)

    // Video: nil outputSettings = deliver compressed samples (stream copy)
    var videoReaderOut: AVAssetReaderTrackOutput? = nil
    if let vt = videoTracks.first {
        let o = AVAssetReaderTrackOutput(track: vt, outputSettings: nil)
        o.alwaysCopiesSampleData = false
        reader.add(o)
        videoReaderOut = o
    }
    // System audio: passthrough
    var sysAudioOuts: [(AVAssetReaderTrackOutput, AVAssetTrack)] = []
    for at in sysAudioTracks {
        let o = AVAssetReaderTrackOutput(track: at, outputSettings: nil)
        o.alwaysCopiesSampleData = false
        reader.add(o)
        sysAudioOuts.append((o, at))
    }

    // Mic: decode to LPCM so we can re-encode as AAC
    let micReader = try AVAssetReader(asset: micAsset)
    micReader.timeRange = CMTimeRange(start: .zero, duration: mixDur)
    let micTracks = try await micAsset.loadTracks(withMediaType: .audio)
    var micReaderOut: AVAssetReaderTrackOutput? = nil
    if let mt = micTracks.first {
        let decomp: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMBitDepthKey: 16,
        ]
        let o = AVAssetReaderTrackOutput(track: mt, outputSettings: decomp)
        micReader.add(o)
        micReaderOut = o
    }

    // ── Writer ───────────────────────────────────────────────────────────────
    try? FileManager.default.removeItem(at: outputURL)
    let writer = try AVAssetWriter(url: outputURL, fileType: .mp4)

    // Video: nil outputSettings = accept compressed samples as-is (stream copy)
    var videoWriterIn: AVAssetWriterInput? = nil
    if let vt = videoTracks.first {
        let fmts = try await vt.load(.formatDescriptions)
        let inp = AVAssetWriterInput(mediaType: .video, outputSettings: nil,
                                    sourceFormatHint: fmts.first)
        inp.expectsMediaDataInRealTime = false
        if let transform = try? await vt.load(.preferredTransform) { inp.transform = transform }
        writer.add(inp)
        videoWriterIn = inp
    }
    // System audio: passthrough
    var sysAudioWriterIns: [AVAssetWriterInput] = []
    for (_, at) in sysAudioOuts {
        let fmts = try await at.load(.formatDescriptions)
        let inp = AVAssetWriterInput(mediaType: .audio, outputSettings: nil,
                                    sourceFormatHint: fmts.first)
        inp.expectsMediaDataInRealTime = false
        writer.add(inp)
        sysAudioWriterIns.append(inp)
    }
    // Mic: AAC encode (only the mic WAV is re-encoded, everything else is copied)
    var micWriterIn: AVAssetWriterInput? = nil
    if micReaderOut != nil {
        let aac: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 44100.0,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 96_000,
        ]
        let inp = AVAssetWriterInput(mediaType: .audio, outputSettings: aac)
        inp.expectsMediaDataInRealTime = false
        writer.add(inp)
        micWriterIn = inp
    }

    guard reader.startReading() else {
        throw reader.error ?? NSError(domain: "kts.sck", code: 6,
            userInfo: [NSLocalizedDescriptionKey: "AVAssetReader (video) startReading failed"])
    }
    guard writer.startWriting() else {
        throw writer.error ?? NSError(domain: "kts.sck", code: 7,
            userInfo: [NSLocalizedDescriptionKey: "AVAssetWriter startWriting failed"])
    }
    writer.startSession(atSourceTime: .zero)

    if micReaderOut != nil {
        guard micReader.startReading() else {
            throw micReader.error ?? NSError(domain: "kts.sck", code: 8,
                userInfo: [NSLocalizedDescriptionKey: "AVAssetReader (mic) startReading failed"])
        }
    }

    // Pump all tracks concurrently, then finish writing.
    let group = DispatchGroup()

    func pump(reader: AVAssetReaderTrackOutput, writer: AVAssetWriterInput, label: String) {
        group.enter()
        let q = DispatchQueue(label: "kts.embed.\(label)")
        writer.requestMediaDataWhenReady(on: q) {
            while writer.isReadyForMoreMediaData {
                if let sb = reader.copyNextSampleBuffer() {
                    writer.append(sb)
                } else {
                    writer.markAsFinished()
                    group.leave()
                    return
                }
            }
        }
    }

    if let vro = videoReaderOut,   let vwi = videoWriterIn   { pump(reader: vro, writer: vwi, label: "video")    }
    for (idx, (saro, _)) in sysAudioOuts.enumerated() {
        if idx < sysAudioWriterIns.count { pump(reader: saro, writer: sysAudioWriterIns[idx], label: "sysaudio\(idx)") }
    }
    if let mro = micReaderOut,     let mwi = micWriterIn     { pump(reader: mro, writer: mwi, label: "mic")      }

    await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
        group.notify(queue: .global()) { cont.resume() }
    }

    if reader.status == .failed {
        sckLog("embedMicAudio: reader failed: \(String(describing: reader.error))")
    }
    try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
        writer.finishWriting {
            if let err = writer.error { cont.resume(throwing: err) }
            else { cont.resume() }
        }
    }
}

@_cdecl("kts_sck_embed_audio")
public func kts_sck_embed_audio(
    _ videoPath: UnsafePointer<CChar>?,
    _ wavPath: UnsafePointer<CChar>?,
    _ outputPath: UnsafePointer<CChar>?,
    _ errOut: UnsafeMutablePointer<CChar>?,
    _ errLen: Int
) -> Int32 {
    guard let videoPath, let wavPath, let outputPath else {
        copyError("chemin null", errOut, errLen); return -1
    }
    let videoURL = URL(fileURLWithPath: String(cString: videoPath))
    let wavURL   = URL(fileURLWithPath: String(cString: wavPath))
    let outURL   = URL(fileURLWithPath: String(cString: outputPath))
    sckLog("kts_sck_embed_audio video=\(videoURL.lastPathComponent) wav=\(wavURL.lastPathComponent)")
    let sem = DispatchSemaphore(value: 0)
    var code: Int32 = 0
    Task {
        do {
            try await embedMicAudio(videoURL: videoURL, wavURL: wavURL, outputURL: outURL)
            sckLog("embedMicAudio OK → \(outURL.lastPathComponent)")
        } catch {
            let msg = String(describing: error)
            sckLog("embedMicAudio échec: \(msg)")
            copyError(msg, errOut, errLen)
            code = -1
        }
        sem.signal()
    }
    sem.wait()
    return code
}

/// Vérifie (et demande si nécessaire) l'accès au microphone via AVFoundation / TCC.
/// Bloquant : utilise un DispatchSemaphore pour attendre la réponse de l'utilisateur.
/// Retourne 0 si l'accès est accordé, -1 sinon (raison dans errOut / errLen).
/// Contrairement à l'enregistrement d'écran, la permission micro prend effet immédiatement
/// dans la session en cours - pas besoin de redémarrer l'application.
@_cdecl("kts_ensure_microphone_access")
public func kts_ensure_microphone_access(
    _ errOut: UnsafeMutablePointer<CChar>?,
    _ errLen: Int
) -> Int32 {
    let denied = "Accès au microphone refusé. " +
        "Active kts-desktop dans Réglages système → Confidentialité et sécurité → Microphone, " +
        "puis réessaie."
    let status = AVCaptureDevice.authorizationStatus(for: .audio)
    switch status {
    case .authorized:
        return 0
    case .notDetermined:
        let sem = DispatchSemaphore(value: 0)
        var granted = false
        AVCaptureDevice.requestAccess(for: .audio) { result in
            granted = result
            sem.signal()
        }
        sem.wait()
        if granted { return 0 }
        copyError(denied, errOut, errLen)
        return -1
    case .denied, .restricted:
        copyError(denied, errOut, errLen)
        return -1
    @unknown default:
        copyError("Statut d'autorisation microphone inconnu.", errOut, errLen)
        return -1
    }
}

final class Recorder: NSObject, SCStreamOutput {
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private let fileURL: URL
    private let sampleQueue = DispatchQueue(label: "com.kts.desktop.sck.samples")
    private var startedSession = false
    private var loggedFirstSample = false
    private var paused = false
    /// Set to true on sampleQueue before markAsFinished() - prevents late SCKit
    /// callbacks from appending to a writer that is being finalised/cancelled.
    private var stopped = false
    private var quality: UInt32 = 1
    /// PTS of the first video frame — used to remap all timestamps to start at 0.
    private var sessionStartPTS: CMTime = .invalid

    func pause() { sampleQueue.async { self.paused = true } }
    func resume() { sampleQueue.async { self.paused = false } }

    static func startRecording(path: String, displayIndex: Int, quality: UInt32) async throws {
        if gRecorder != nil {
            sckLog("startRecording: nettoyage enregistrement précédent")
            try await stopRecording()
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let displays = content.displays.sorted {
            if $0.frame.origin.x != $1.frame.origin.x {
                return $0.frame.origin.x < $1.frame.origin.x
            }
            return $0.frame.origin.y < $1.frame.origin.y
        }
        sckLog("SCShareableContent: \(displays.count) écran(s), index demandé=\(displayIndex)")
        guard displayIndex >= 0, displayIndex < displays.count else {
            throw NSError(
                domain: "kts.sck",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Index écran invalide (\(displayIndex)), \(displays.count) écran(s)."]
            )
        }
        let display = displays[displayIndex]
        sckLog("display choisi: id=\(display.displayID) taille=\(display.width)x\(display.height) frame=\(display.frame)")
        let rec = try Recorder(path: path, display: display, quality: quality)
        gRecorder = rec
        try await rec.stream?.startCapture()
        sckLog("SCStream.startCapture() retourné")
    }

    static func stopRecording() async throws {
        guard let rec = gRecorder else { return }
        try await rec.shutdown()
        gRecorder = nil
    }

    private init(path: String, display: SCDisplay, quality: UInt32) throws {
        self.fileURL = URL(fileURLWithPath: path)
        self.quality = quality
        super.init()
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let cfg = SCStreamConfiguration()
        // Resolution scale and frame rate based on quality.
        let scaleFactor: Double
        let fps: Int32
        switch quality {
        case 0:  scaleFactor = 0.5;  fps = 15   // Low
        case 2:  scaleFactor = 1.0;  fps = 30   // High
        default: scaleFactor = 0.75; fps = 20   // Medium
        }
        cfg.width  = max(2, Int(Double(display.width)  * scaleFactor))
        cfg.height = max(2, Int(Double(display.height) * scaleFactor))
        cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        cfg.showsCursor = true
        // Audio system (macOS 13+) : capture le son de l'écran enregistré.
        if #available(macOS 13, *) {
            cfg.capturesAudio = true
            cfg.sampleRate = 48000
            cfg.channelCount = 2
        }
        let st = SCStream(filter: filter, configuration: cfg, delegate: nil)
        self.stream = st
        try st.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        if #available(macOS 13, *) {
            try st.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
            sckLog("Recorder init OK quality=\(quality) \(cfg.width)x\(cfg.height) \(fps)fps, addStreamOutput(.screen + .audio)")
        } else {
            sckLog("Recorder init OK quality=\(quality) \(cfg.width)x\(cfg.height) \(fps)fps, addStreamOutput(.screen) [audio indisponible <macOS 13]")
        }
    }

    private func shutdown() async throws {
        sckLog("shutdown début (stream=\(stream != nil) writer=\(writer != nil) startedSession=\(startedSession))")
        if let st = stream {
            try await st.stopCapture()
            sckLog("stopCapture() OK")
        }
        stream = nil
        // Drain sampleQueue then atomically set stopped=true before markAsFinished().
        // This prevents late SCKit callbacks (delivered after stopCapture returns but
        // before the stream fully quiesces) from appending to a writer that is
        // already being finalised, which would put it into status=failed (-11800/-16122).
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            sampleQueue.async {
                self.stopped = true
                cont.resume()
            }
        }
        videoInput?.markAsFinished()
        audioInput?.markAsFinished()
        if let w = writer {
            sckLog("finishWriting (status avant=\(w.status.rawValue) error=\(String(describing: w.error)))")
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                w.finishWriting {
                    cont.resume()
                }
            }
            let finalStatus = w.status
            sckLog("finishWriting terminé status=\(finalStatus.rawValue) error=\(String(describing: w.error))")
            if finalStatus == .failed {
                throw w.error ?? NSError(
                    domain: "kts.sck", code: 5,
                    userInfo: [NSLocalizedDescriptionKey: "AVAssetWriter finishWriting failed (status=failed)"]
                )
            }
        }
        writer = nil
        videoInput = nil
        sckLog("shutdown fin")
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        if outputType == .screen {
            sampleQueue.async { [weak self] in self?.appendVideoSample(sampleBuffer) }
            return
        }
        if #available(macOS 13, *), outputType == .audio {
            sampleQueue.async { [weak self] in self?.appendAudioSample(sampleBuffer) }
        }
    }

    // ── Timestamp remapping ───────────────────────────────────────────────────
    // SCKit delivers frames with absolute host-clock CMTime values (>> 0).
    // Remapping them to start at 0 avoids a video with a huge black gap at the
    // beginning that would otherwise last as long as the system has been running.

    private func remapSampleBuffer(_ sb: CMSampleBuffer) -> CMSampleBuffer? {
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        if !pts.isValid { return sb }
        if sessionStartPTS == .invalid {
            sessionStartPTS = pts
        }
        let relative = CMTimeSubtract(pts, sessionStartPTS)
        // Clamp to zero to silently discard samples that arrive fractionally before
        // the session start (can happen when audio precedes the first video frame by <1ms).
        let remappedPTS = relative.seconds < 0 ? CMTime.zero : relative
        var timing = CMSampleTimingInfo(
            duration: CMSampleBufferGetDuration(sb),
            presentationTimeStamp: remappedPTS,
            decodeTimeStamp: .invalid
        )
        var out: CMSampleBuffer?
        let status = CMSampleBufferCreateCopyWithNewTiming(
            allocator: kCFAllocatorDefault,
            sampleBuffer: sb,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleBufferOut: &out
        )
        return status == noErr ? out : sb
    }

    // ── Vidéo ─────────────────────────────────────────────────────────────────

    private func appendVideoSample(_ sb: CMSampleBuffer) {
        if stopped || paused { return }
        if !loggedFirstSample {
            loggedFirstSample = true
            sckLog("premier sampleBuffer reçu (outputType screen)")
        }
        if writer == nil {
            guard let desc = CMSampleBufferGetFormatDescription(sb) else {
                sckLog("appendVideoSample: CMSampleBufferGetFormatDescription nil")
                return
            }
            let dims = CMVideoFormatDescriptionGetDimensions(desc)
            // H.264, no explicit color properties — let the encoder infer from source
            // (explicit AVVideoColorPropertiesKey with BT.709 causes encoder failure -11800/-16122
            // on some macOS versions when the VT session rejects the declared color metadata).
            var compressionSettings: [String: Any] = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: NSNumber(value: dims.width),
                AVVideoHeightKey: NSNumber(value: dims.height),
            ]
            let videoBitrate: Int? = quality == 0 ? 1_500_000 : quality == 1 ? 4_000_000 : nil
            if let bitrate = videoBitrate {
                compressionSettings[AVVideoCompressionPropertiesKey] = [AVVideoAverageBitRateKey: NSNumber(value: bitrate)]
            }
            do {
                let w = try AVAssetWriter(url: fileURL, fileType: .mp4)
                let input = AVAssetWriterInput(mediaType: .video, outputSettings: compressionSettings)
                input.expectsMediaDataInRealTime = true
                guard w.canAdd(input) else {
                    sckLog("canAdd (video) échec status=\(w.status.rawValue) error=\(String(describing: w.error))")
                    throw KtsSckError.writerSetup
                }
                w.add(input)
                if #available(macOS 13, *) {
                    let audioBitrate: Int = quality == 0 ? 96_000 : quality == 2 ? 192_000 : 128_000
                    let audioSettings: [String: Any] = [
                        AVFormatIDKey: kAudioFormatMPEG4AAC,
                        AVSampleRateKey: 48000.0,
                        AVNumberOfChannelsKey: 2,
                        AVEncoderBitRateKey: audioBitrate,
                    ]
                    let ai = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
                    ai.expectsMediaDataInRealTime = true
                    if w.canAdd(ai) {
                        w.add(ai)
                        self.audioInput = ai
                        sckLog("audioInput AAC 48kHz stéréo ajouté")
                    } else {
                        sckLog("audioInput canAdd échec (status=\(w.status.rawValue)) - audio absent du MP4")
                    }
                }
                self.writer = w
                self.videoInput = input
                guard w.startWriting() else {
                    sckLog("startWriting() échec: \(String(describing: w.error))")
                    throw KtsSckError.writerSetup
                }
                // .zero accepts all epoch-based SCKit timestamps (they are all >> 0).
                // Using the first sample's PTS caused audio frames arriving just before it
                // to fall outside the session window and silently fail, corrupting the writer.
                w.startSession(atSourceTime: .zero)
                startedSession = true
                sckLog("AVAssetWriter démarré → \(fileURL.path) (\(dims.width)x\(dims.height))")
            } catch {
                sckLog("AVAssetWriter init/start échec: \(error)")
                return
            }
        }
        guard startedSession, let vi = videoInput else { return }
        guard let remapped = remapSampleBuffer(sb) else { return }
        if vi.isReadyForMoreMediaData {
            if !vi.append(remapped) {
                sckLog("videoInput.append a retourné false (writer status=\(writer?.status.rawValue ?? -1) error=\(String(describing: writer?.error)))")
                // Writer entered a failed state — stop appending to break the error loop.
                if writer?.status == .failed { stopped = true }
            }
        } else {
            sckLog("videoInput: isReadyForMoreMediaData == false, frame ignorée")
        }
    }

    // ── Audio ──────────────────────────────────────────────────────────────────

    private func appendAudioSample(_ sb: CMSampleBuffer) {
        if stopped || paused { return }
        guard startedSession, let ai = audioInput else { return }
        guard let remapped = remapSampleBuffer(sb) else { return }
        if ai.isReadyForMoreMediaData {
            if !ai.append(remapped) {
                sckLog("audioInput.append a retourné false (writer status=\(writer?.status.rawValue ?? -1))")
                if writer?.status == .failed { stopped = true }
            }
        }
    }
}
