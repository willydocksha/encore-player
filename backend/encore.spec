# pyinstaller spec for the encore app: pyinstaller backend/encore.spec (run from the repo root)
# mac -> dist/Encore.app, windows -> dist/Encore/Encore.exe, linux -> dist/Encore/Encore
# the app only has the classic analysis; the ai engine is built separately (backend/engine.spec)

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

ROOT = Path(SPECPATH).parent
MAC = sys.platform == "darwin"
WIN = sys.platform == "win32"

# the web app, served from the bundle root
datas = [(str(ROOT / "index.html"), "."), (str(ROOT / "sw.js"), "."), (str(ROOT / "manifest.webmanifest"), "."),
         (str(ROOT / "app"), "app")]
datas += [(str(p), ".") for p in ROOT.glob("icon-*.png")]
# the analysis code as a file: the ai engine runs it (backend/ai.py), so app updates keep the engine
datas += [(str(ROOT / "backend" / "pipeline.py"), "engine")]
binaries = []
hiddenimports = collect_submodules("uvicorn")

# packages that load stubs or binaries from their own folder
for pkg in ("librosa", "imageio_ffmpeg", "yt_dlp_ejs"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h
datas += collect_data_files("lazy_loader")

a = Analysis(
    [str(ROOT / "backend" / "main.py")],
    pathex=[str(ROOT / "backend")],
    datas=datas,
    binaries=binaries,
    hiddenimports=hiddenimports,
    # the ai stack lives in the engine; plus big optional extras nothing here uses
    excludes=["torch", "torchaudio", "torchvision", "demucs", "beat_this", "basic_pitch", "onnxruntime", "onnx",
              "onnxscript", "julius", "dora", "openunmix", "lameenc", "rotary_embedding_torch", "einops",
              "huggingface_hub", "hf_xet", "sympy", "tensorflow", "coremltools", "tflite_runtime", "matplotlib",
              "tkinter", "IPython", "notebook", "pytest", "PIL"],
)
pyz = PYZ(a.pure)
icon = str(ROOT / "icon-512.png")
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="Encore",
    # windows / linux keep a terminal window: closing it stops encore
    console=not MAC,
    icon=icon,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="Encore", upx=False)
if MAC:
    app = BUNDLE(
        coll,
        name="Encore.app",
        icon=icon,
        bundle_identifier="id.encore.app",
        info_plist={"CFBundleShortVersionString": "1.0.0", "NSHighResolutionCapable": True, "LSMinimumSystemVersion": "12.0"},
    )
