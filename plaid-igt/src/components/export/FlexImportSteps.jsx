// How a FLEx export is brought into FieldWorks. The order matters (the texts
// name their entries, so the entries go first), and each import only appears
// in FLEx's File > Import menu from one area of the program, which is the part
// nobody finds unaided. Shown wherever a FLEx export is chosen. The README in
// the .zip says the same (flexReadme in export/runExport.js).
export const FlexImportSteps = ({ lexicon }) => (
  <div className="border-t pt-3 text-xs text-muted-foreground">
    <p className="font-medium text-foreground">
      {lexicon ? 'Importing into FLEx, in this order' : 'Importing into FLEx'}
    </p>
    {lexicon ? (
      <ol className="mt-1 list-inside list-decimal space-y-0.5">
        <li>
          In the Lexicon area: File &gt; Import &gt; LIFT Lexicon, and choose the .lift. Keep the
          .lift-ranges beside it.
        </li>
        <li>
          In the Texts &amp; Words area: File &gt; Import &gt; FLExText Interlinear, and choose the
          .flextext.
        </li>
      </ol>
    ) : (
      <p className="mt-1">
        In the Texts &amp; Words area: File &gt; Import &gt; FLExText Interlinear, and choose the
        .flextext.
      </p>
    )}
  </div>
);
