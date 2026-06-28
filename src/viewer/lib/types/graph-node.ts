// A node of the constellation: the central hub or an orbiting satellite (satellites
// carry a twinkle phase tw; the hub does not).
interface GraphNode {
  x: number;
  y: number;
  r: number;
  hub: boolean;
  tw?: number;
}
