using Microsoft.AspNetCore.Mvc;
using Solvix.Contracts.Facades;

namespace Solvix.Api.Controllers;

/// <summary>
/// The cube constructor's backend: ready-made shapes, the parametric block, and
/// the validity check. Not tied to a session - a shape is designed first and
/// only then attached to a mesh (see MeshEditorController).
/// </summary>
[ApiController]
[Route("api/mesh-editor/shapes")]
public class MeshShapesController(IMeshBuilderFacade meshBuilder) : ControllerBase
{
    [HttpGet("presets")]
    public ActionResult<IReadOnlyList<MeshShapePresetDto>> Presets() => Ok(meshBuilder.ShapePresets());

    [HttpPost("parametric")]
    public ActionResult<MeshShapeDto> Parametric([FromBody] MeshShapeParametersDto parameters) => meshBuilder.BuildShape(parameters);

    [HttpPost("check")]
    public ActionResult<MeshShapeCheckDto> Check([FromBody] MeshShapeDto shape) => meshBuilder.CheckShape(shape);
}
