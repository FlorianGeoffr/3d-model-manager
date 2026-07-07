"""Recorded NORMALIZED status snapshots -- the shape app.printers.bambu._snapshot
produces and printerd stores. The bambulabs_api lib owns the raw MQTT merge,
so these pin only the logic WE still own: snapshot -> PrinterPublicState and
gcode_state -> PrintJobState."""

SNAPSHOT_IDLE = {
    "gcode_state": "IDLE",
    "mc_percent": 0,
    "layer_num": 0,
    "total_layer_num": 0,
    "mc_remaining_time": 0,
    "print_error": 0,
    "nozzle_temper": 24.0,
    "bed_temper": 23.0,
    "subtask_name": "",
    "wifi_signal": "-42dBm",
}
SNAPSHOT_PRINTING = {
    "gcode_state": "RUNNING",
    "mc_percent": 55,
    "layer_num": 66,
    "total_layer_num": 120,
    "mc_remaining_time": 21,
    "print_error": 0,
    "nozzle_temper": 220.0,
    "bed_temper": 60.0,
    "subtask_name": "widget",
    "wifi_signal": "-45dBm",
}
SNAPSHOT_FINISH = {
    "gcode_state": "FINISH",
    "mc_percent": 100,
    "mc_remaining_time": 0,
    "print_error": 0,
    "subtask_name": "widget",
}
SNAPSHOT_ERROR = {"gcode_state": "FAILED", "print_error": 83935248, "subtask_name": "widget"}
