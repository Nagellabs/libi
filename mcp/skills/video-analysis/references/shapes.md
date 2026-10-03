# Analysis payload shapes

`libi.analysis_save` takes two nested payloads that its schema does not spell out: the frames batch and the
summary. The server validates both in full and answers a bad one with the exact field path (for example
`frames.2.description.scene: Required`), so fix what it names and call again. Optional fields are marked `?`.
A field not listed here is dropped without an error; the `custom` bags are the place for extras.

## `action: "frames"`: `frames` is a list of entries

```
{ frameIndex: int >= 0,       // keep the index `libi.analysis_extract` returned (the upsert key)
  timestamp: number,          // seconds
  filePath: string,           // relative to the frames dir, as extract returned it: "frame-0001.png"
  description?: FrameDescription,   // required unless skipped
  skipped?: boolean, skipReason?: string,   // black or unusable frame: skip it with a reason
  custom?: { ... } }
```

`FrameDescription` (`frame_v1`). A string holding this JSON is accepted, an object is better:

```
{ schema_version: "frame_v1",
  frame_index: int >= 0,      // the same number as the entry's frameIndex
  timestamp: number,          // seconds
  scene: string,              // one sentence
  setting: { location: string, time_of_day?: "day"|"evening"|"night"|"unknown", lighting?: string },
  people: [{ id?: string,     // STABLE across frames for the same person: "lisa", "person_1"
             name?: string,   // when identifiable and worth cataloging
             description: string,
             bbox?: [x, y, w, h],   // normalized 0..1 of the source frame; give one for anyone to be tracked
             pose?: string,
             facing?: "camera"|"left"|"right"|"away"|"unknown",
             visible_parts?: ("face"|"torso"|"hands"|"legs"|"feet")[] }],
  objects: [{ name: string, bbox?: [x, y, w, h], description?: string }],
  text_on_screen?: string[],
  camera?: { shot?: "close-up"|"medium"|"wide"|"extreme-wide",
             angle?: "eye-level"|"high"|"low"|"dutch",
             motion?: "static"|"pan"|"zoom"|"shake" },
  actions?: string[], tags?: string[],
  custom?: { ... } }          // open bag: text treatment, motion notes, anything else
```

`people` and `objects` are required lists; send `[]` when there are none.

## `action: "summary"`: `summary` is one object

```
{ schema_version: "video_v1",
  overview: string,           // 2-3 sentence narrative
  duration: number,           // seconds
  subjects: [{ id: string,    // matches people[].id in the frames
               name?: string, description: string,
               appearance_frame_indices: int[], appearance_timestamps: number[] }],
  sections: [{ start: number, end: number, description: string, frame_indices: int[] }],
  recurring_objects: [{ name: string, count: int }],
  visual_style?: string, audio_summary?: string,
  custom?: { ... } }
```

`subjects`, `sections` and `recurring_objects` are required lists; empty arrays are fine when unknown.

## Other actions

- `summary_custom`: `{ fileId, path, value }` sets one key of `summary.custom`.
- `step_failed`: `{ fileId, kind: "transcript"|"summary"|"frames", errorMessage }`.
- `remove_step`: `{ fileId, kind }`; clears the step (and its keyframes for `frames`) so it can be redone.
