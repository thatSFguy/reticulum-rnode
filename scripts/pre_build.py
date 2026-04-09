# reticulum-rnode / scripts/pre_build.py
# Version stamping and linker fix for nRF52840.

import os
import subprocess

Import("env")  # noqa: F821

# ---- Version stamp from git ----
try:
    git_version = subprocess.check_output(
        ["git", "describe", "--tags", "--always"],
        stderr=subprocess.DEVNULL,
    ).decode("utf-8").strip()
except Exception:
    git_version = "dev"

env.Append(CPPDEFINES=[("RLR_VERSION", env.StringifyMacro(git_version))])
print("pre_build: RLR_VERSION = {}".format(git_version))

# ---- Remove --specs=nano.specs from LINKFLAGS ----
# newlib-nano doesn't support C++ exceptions. The nordicnrf52 platform
# adds it programmatically after build_unflags is processed.
platform = env.GetProjectOption("platform")
if platform == "nordicnrf52":
    if "--specs=nano.specs" in env["LINKFLAGS"]:
        env["LINKFLAGS"].remove("--specs=nano.specs")
        print("pre_build: removed --specs=nano.specs from LINKFLAGS")

# ---- Install custom linker script for XIAO nRF52840 (S140 v7) ----
_bsp_linker_dir = os.path.join(
    env.subst("$PROJECT_PACKAGES_DIR"),
    "framework-arduinoadafruitnrf52", "cores", "nRF5", "linker"
)
_v7_ld_src = os.path.join(env.subst("$PROJECT_DIR"), "linker", "nrf52840_s140_v7.ld")
_v7_ld_dst = os.path.join(_bsp_linker_dir, "nrf52840_s140_v7.ld")
if os.path.exists(_v7_ld_src) and not os.path.exists(_v7_ld_dst):
    import shutil
    os.makedirs(_bsp_linker_dir, exist_ok=True)
    shutil.copy2(_v7_ld_src, _v7_ld_dst)
    print("pre_build: installed nrf52840_s140_v7.ld to BSP linker directory")

# ---- UF2 generation ----
import sys as _sys
_scripts_dir = os.path.join(env.subst("$PROJECT_DIR"), "scripts")
if _scripts_dir not in _sys.path:
    _sys.path.insert(0, _scripts_dir)
import hex2uf2 as _hex2uf2

def _generate_uf2(source, target, env):
    firmware_dir = env.subst("$BUILD_DIR")
    hex_path = os.path.join(firmware_dir, "firmware.hex")
    uf2_path = os.path.join(firmware_dir, "firmware.uf2")
    if os.path.exists(hex_path):
        _hex2uf2.convert_to_uf2(hex_path, uf2_path)

env.AddPostAction("buildprog", _generate_uf2)
