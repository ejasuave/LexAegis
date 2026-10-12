# AI-assisted review summary (SYNTHETIC)

This text was written by the project team as an example of what a caller might supply. It is NOT the
output of a measured model run and says nothing about any real change.

- The change trims the input and rejects an empty name before building the greeting.
- Callers that passed an empty string previously received "Hello " and will now see an error.
- No test was added for the empty-name path.
