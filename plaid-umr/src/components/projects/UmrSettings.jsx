import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';

// The UMR settings section. The lattice levels, the value sets a project
// allows beyond the validator's, and which ILG header feeds which gloss line
// are all settings this screen will hold. Nothing here yet.
export const UmrSettings = () => (
  <Card>
    <CardHeader>
      <CardTitle className="text-lg">UMR settings</CardTitle>
    </CardHeader>
    <CardContent>
      <p className="text-sm text-muted-foreground">
        The lattice levels and the gloss lines arrive here in a later release.
      </p>
    </CardContent>
  </Card>
);
