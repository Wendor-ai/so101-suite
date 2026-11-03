# Third-party notices

SO-101 Suite is licensed under the **GNU Affero General Public License v3.0 or later** (see `LICENSE`).
It includes, or depends on, the following third-party software, each under its own licence.

| Component | Where | Licence |
|---|---|---|
| three.js r128, plus `OrbitControls`, `STLLoader`, `Reflector` from its examples | `app/vendor/` (licence headers kept in the files) | MIT |
| SO-101 URDF and STL meshes (from the SO-ARM100 project) | `app/assets/so101/` (licence text in `app/assets/so101/LICENSE`) | Apache-2.0 |
| feetech-servo-sdk (`scservo_sdk`) | Python dependency | Unlicense (public domain) |
| OpenCV (`opencv-python-headless`) | Python dependency (its wheels bundle further libraries with their own notices) | Apache-2.0 |
| NumPy | Python dependency | BSD-3-Clause |
| pySerial | Python dependency | BSD-3-Clause |
| LeRobot by Hugging Face | Optional extra (`uv sync --extra lerobot`), not bundled | Apache-2.0 |
| Astro | Build tool for the website in `site/` only | MIT |

## Not affiliated

SO-101 Suite is an independent, community project. It is not affiliated with, sponsored by or endorsed by
Hugging Face (LeRobot), The Robot Studio (SO-ARM100 / SO-101) or Feetech. Product names belong to their owners.

The SO-101 hardware designs and the official build guide are at <https://github.com/TheRobotStudio/SO-ARM100>
and <https://huggingface.co/docs/lerobot/so101>.
