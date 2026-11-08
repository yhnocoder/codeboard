/* box's C ABI (packages/box/ffi). Made by cbindgen: BOX_WRITE_HEADER=1 cargo test -p box-ffi writes it again */

#ifndef BOX_H
#define BOX_H

#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

// An open index (one per data folder in a process; dropping it, box_close, stops its background indexing)
typedef struct BoxIndex BoxIndex;

#ifdef __cplusplus
extern "C" {
#endif // __cplusplus

// Opens (making it if missing) the index in the data folder `home`, a UTF-8 path. Answers NULL when it cannot, with the
// reason in *error when error is not NULL (free it with box_string_free)
//
// # Safety
// home is a NUL-terminated string; error is NULL or points to writable storage for one pointer
BoxIndex *box_open(const char *home,
                   char **error);

// One request (JSON with its "op") → its answer as JSON: {"result": …} or {"error": "…"}. Never NULL; free the answer
// with box_string_free
//
// # Safety
// index comes from box_open and is not closed; request is a NUL-terminated string
char *box_request(const BoxIndex *index,
                  const char *request);

// Frees a string box handed out (NULL: nothing)
//
// # Safety
// s comes from box_request or box_open's error, and is freed once
void box_string_free(char *s);

// Closes the index: background indexing stops after its current batch; the data folder is free for another process once
// that batch is done
//
// # Safety
// index comes from box_open and is closed once
void box_close(BoxIndex *index);

#ifdef __cplusplus
}  // extern "C"
#endif  // __cplusplus

#endif  /* BOX_H */
