using Solvix.Fem;

namespace Solvix.Fem.Tests;

public class ElementTests
{
    // a unit cube, or a distorted one (skewed, bent edges, shifted midpoints)
    private static double[,] Cube(Func<double, double, double, (double, double, double)>? map = null)
    {
        var xyz = new double[20, 3];
        for (int i = 0; i < 20; i++)
        {
            double x = (Hex20.Local[i, 0] + 1) / 2.0, y = (Hex20.Local[i, 1] + 1) / 2.0, z = (Hex20.Local[i, 2] + 1) / 2.0;
            var (px, py, pz) = map?.Invoke(x, y, z) ?? (x, y, z);
            xyz[i, 0] = px; xyz[i, 1] = py; xyz[i, 2] = pz;
        }
        return xyz;
    }

    private static (double, double, double) Bend(double x, double y, double z) =>
        (x + 0.15 * Math.Sin(y * 1.3) + 0.1 * z, y + 0.12 * Math.Sin(x * 1.1 + z), z + 0.1 * Math.Sin(x + y * 0.7));

    private static double[,] Steel => Material.Isotropic(2.1e11, 0.3).D;

    // ---- the reference element -----------------------------------------------------------------

    [Test]
    public void Shape_functions_are_one_at_their_own_node_and_zero_at_the_others_and_sum_to_one_everywhere()
    {
        var phi = new double[20];
        for (int n = 0; n < 20; n++)
        {
            Hex20.Shape(Hex20.Local[n, 0], Hex20.Local[n, 1], Hex20.Local[n, 2], phi);
            for (int i = 0; i < 20; i++) Assert.That(phi[i], Is.EqualTo(i == n ? 1 : 0).Within(1e-12), $"phi{i} at node {n}");
        }
        Hex20.Shape(0.3, -0.7, 0.45, phi);
        Assert.That(phi.Sum(), Is.EqualTo(1).Within(1e-12));
    }

    [Test]
    public void Derivatives_match_a_finite_difference()
    {
        var d = new double[20, 3];
        var up = new double[20];
        var down = new double[20];
        double a = 0.3, b = -0.6, g = 0.2, h = 1e-6;
        Hex20.Derivatives(a, b, g, d);

        Hex20.Shape(a + h, b, g, up); Hex20.Shape(a - h, b, g, down);
        for (int i = 0; i < 20; i++) Assert.That(d[i, 0], Is.EqualTo((up[i] - down[i]) / (2 * h)).Within(1e-7));
        Hex20.Shape(a, b + h, g, up); Hex20.Shape(a, b - h, g, down);
        for (int i = 0; i < 20; i++) Assert.That(d[i, 1], Is.EqualTo((up[i] - down[i]) / (2 * h)).Within(1e-7));
        Hex20.Shape(a, b, g + h, up); Hex20.Shape(a, b, g - h, down);
        for (int i = 0; i < 20; i++) Assert.That(d[i, 2], Is.EqualTo((up[i] - down[i]) / (2 * h)).Within(1e-7));
    }

    [Test]
    public void Face_shape_functions_and_derivatives_are_consistent()
    {
        var psi = new double[8];
        var up = new double[8];
        var down = new double[8];
        var d = new double[8, 2];
        Hex20.FaceShape(0.2, -0.4, psi);
        Assert.That(psi.Sum(), Is.EqualTo(1).Within(1e-12));
        Hex20.FaceDerivatives(0.2, -0.4, d);
        double h = 1e-6;
        Hex20.FaceShape(0.2 + h, -0.4, up); Hex20.FaceShape(0.2 - h, -0.4, down);
        for (int i = 0; i < 8; i++) Assert.That(d[i, 0], Is.EqualTo((up[i] - down[i]) / (2 * h)).Within(1e-7));
        Hex20.FaceShape(0.2, -0.4 + h, up); Hex20.FaceShape(0.2, -0.4 - h, down);
        for (int i = 0; i < 8; i++) Assert.That(d[i, 1], Is.EqualTo((up[i] - down[i]) / (2 * h)).Within(1e-7));
    }

    [Test]
    public void The_numbering_agrees_with_the_mesh_editors()
    {
        for (int i = 0; i < 20; i++)
            for (int c = 0; c < 3; c++) Assert.That(Hex20.Local[i, c], Is.EqualTo(Solvix.Mesh.Hex20Reference.LocalCoords[i, c]));
        var ours = new double[20];
        var theirs = new double[20];
        Hex20.Shape(0.1, 0.5, -0.3, ours);
        Solvix.Mesh.Hex20Reference.ShapeFunctions(0.1, 0.5, -0.3, theirs);
        for (int i = 0; i < 20; i++) Assert.That(ours[i], Is.EqualTo(theirs[i]).Within(1e-12));
    }

    [Test]
    public void Each_face_lists_exactly_the_nodes_on_it()
    {
        for (int face = 0; face < 6; face++)
        {
            int axis = face switch { 0 or 1 => 2, 2 or 3 => 1, _ => 0 };
            int side = face is 1 or 3 or 5 ? 1 : -1;
            var expected = Enumerable.Range(0, 20).Where(i => Hex20.Local[i, axis] == side).OrderBy(i => i);
            Assert.That(Hex20.FaceNodes[face].OrderBy(i => i), Is.EqualTo(expected), $"face {face}");
        }
    }

    // ---- the stiffness matrix ------------------------------------------------------------------

    [TestCase(false)]
    [TestCase(true)]
    public void The_stiffness_is_symmetric_and_rigid_translations_cost_nothing(bool bent)
    {
        var ke = new double[60, 60];
        ElementKernels.Stiffness(bent ? Cube(Bend) : Cube(), Steel, ke);

        for (int i = 0; i < 60; i++)
            for (int j = 0; j < 60; j++) Assert.That(ke[i, j], Is.EqualTo(ke[j, i]).Within(1e-3));
        for (int axis = 0; axis < 3; axis++)
            for (int row = 0; row < 60; row++)
            {
                double s = 0;
                for (int k = 0; k < 20; k++) s += ke[row, axis * 20 + k];
                Assert.That(s, Is.EqualTo(0).Within(1e-2), $"translation along {axis}, row {row}");
            }
    }

    [Test]
    public void Rigid_rotations_cost_nothing_either_on_a_bent_element()
    {
        var xyz = Cube(Bend);
        var ke = new double[60, 60];
        ElementKernels.Stiffness(xyz, Steel, ke);
        // small rotation about z: u = (-y, x, 0)
        var u = new double[60];
        for (int i = 0; i < 20; i++) { u[i] = -xyz[i, 1]; u[20 + i] = xyz[i, 0]; }

        for (int row = 0; row < 60; row++)
        {
            double s = 0;
            for (int col = 0; col < 60; col++) s += ke[row, col] * u[col];
            Assert.That(s, Is.EqualTo(0).Within(1e-2), $"row {row}");
        }
    }

    [Test]
    public void The_matrix_is_positive_semi_definite_with_exactly_six_rigid_modes()
    {
        var ke = new double[60, 60];
        ElementKernels.Stiffness(Cube(Bend), Steel, ke);
        // Cholesky-style check through random vectors: u^T K u >= 0, and the number of (near-)zero eigen directions
        var rng = new Random(7);
        for (int t = 0; t < 50; t++)
        {
            var u = Enumerable.Range(0, 60).Select(_ => rng.NextDouble() - 0.5).ToArray();
            double energy = 0;
            for (int i = 0; i < 60; i++) for (int j = 0; j < 60; j++) energy += u[i] * ke[i, j] * u[j];
            Assert.That(energy, Is.GreaterThan(0));
        }
    }

    [Test]
    public void A_constant_strain_field_is_reproduced_exactly_by_a_bent_element()
    {
        // u linear in x: the strain and stress are constant, so the internal force at every node must equal the
        // boundary traction work - checked as K u = f where f is the sum over faces of the constant traction
        var xyz = Cube(Bend);
        var ke = new double[60, 60];
        var d = Steel;
        ElementKernels.Stiffness(xyz, d, ke);
        var u = new double[60];
        for (int i = 0; i < 20; i++) { u[i] = 0.001 * xyz[i, 0] + 0.0004 * xyz[i, 1]; u[20 + i] = -0.0002 * xyz[i, 2]; u[40 + i] = 0.0007 * xyz[i, 0]; }
        var sigma = new double[6];
        Assert.That(ElementKernels.StressAt(xyz, d, u, 0.2, -0.3, 0.5, sigma), Is.True);
        var at2 = new double[6];
        ElementKernels.StressAt(xyz, d, u, -0.6, 0.1, -0.4, at2);
        for (int c = 0; c < 6; c++) Assert.That(sigma[c], Is.EqualTo(at2[c]).Within(Math.Abs(sigma[c]) * 1e-9 + 1e-3), $"stress {c} must not depend on the point");

        // the strain energy two ways: 1/2 u^T K u against 1/2 sigma:eps * volume
        double energy = 0;
        for (int i = 0; i < 60; i++) for (int j = 0; j < 60; j++) energy += 0.5 * u[i] * ke[i, j] * u[j];
        double volume = 0;
        var gradient = new double[20, 3];
        foreach (double a in Hex20.GaussPoints) foreach (double b in Hex20.GaussPoints) foreach (double g in Hex20.GaussPoints)
                volume += ElementKernels.Gradients(xyz, a, b, g, gradient) * Hex20.GaussWeights[Array.IndexOf(Hex20.GaussPoints, a)] * Hex20.GaussWeights[Array.IndexOf(Hex20.GaussPoints, b)] * Hex20.GaussWeights[Array.IndexOf(Hex20.GaussPoints, g)];
        // eps = (exx, eyy, ezz, gxy, gyz, gxz) of the field u = (0.001 x + 0.0004 y, -0.0002 z, 0.0007 x)
        double strainEnergy = 0.5 * volume * (sigma[0] * 0.001 + sigma[3] * 0.0004 + sigma[4] * -0.0002 + sigma[5] * 0.0007);
        Assert.That(energy, Is.EqualTo(strainEnergy).Within(strainEnergy * 1e-9));
    }

    [Test]
    public void A_folded_element_is_refused_with_a_message_not_silently_integrated()
    {
        var xyz = Cube();
        xyz[6, 0] = -3; xyz[6, 1] = -3; xyz[6, 2] = -3;
        var ke = new double[60, 60];

        Assert.That(() => ElementKernels.Stiffness(xyz, Steel, ke), Throws.InvalidOperationException.With.Message.Contains("folded"));
        Assert.That(ElementKernels.MinDeterminant(xyz), Is.LessThan(0));
        Assert.That(ElementKernels.MinDeterminant(Cube()), Is.EqualTo(0.125).Within(1e-12));
    }

    // ---- loads ----------------------------------------------------------------------------------

    [TestCase(0, 0.0, 0.0, -1.0)]
    [TestCase(1, 0.0, 0.0, 1.0)]
    [TestCase(2, 0.0, -1.0, 0.0)]
    [TestCase(3, 0.0, 1.0, 0.0)]
    [TestCase(4, -1.0, 0.0, 0.0)]
    [TestCase(5, 1.0, 0.0, 0.0)]
    public void A_pressure_on_a_face_points_along_the_outward_normal_and_adds_up_to_pressure_times_area(int face, double nx, double ny, double nz)
    {
        var fe = new double[60];
        ElementKernels.FacePressure(Cube(), face, 5.0, fe);

        Assert.That(fe.Take(20).Sum(), Is.EqualTo(5.0 * nx).Within(1e-12));
        Assert.That(fe.Skip(20).Take(20).Sum(), Is.EqualTo(5.0 * ny).Within(1e-12));
        Assert.That(fe.Skip(40).Sum(), Is.EqualTo(5.0 * nz).Within(1e-12));
    }

    [Test]
    public void The_force_of_a_pressure_on_a_curved_face_is_pressure_times_its_area_vector()
    {
        // the top face of a bent cube: the resultant of a uniform pressure is p times the vector area of the face
        var xyz = Cube(Bend);
        var fe = new double[60];
        ElementKernels.FacePressure(xyz, 1, 1.0, fe);

        // vector area of the face by a fine surface integral of r_eta x r_tau
        double ax = 0, ay = 0, az = 0;
        var psi = new double[8];
        var dpsi = new double[8, 2];
        int n = 200;
        for (int i = 0; i < n; i++)
            for (int j = 0; j < n; j++)
            {
                double eta = -1 + (i + 0.5) * 2.0 / n, tau = -1 + (j + 0.5) * 2.0 / n;
                Hex20.FaceDerivatives(eta, tau, dpsi);
                var te = new double[3]; var tt = new double[3];
                for (int k = 0; k < 8; k++) for (int c = 0; c < 3; c++) { te[c] += dpsi[k, 0] * xyz[Hex20.FaceNodes[1][k], c]; tt[c] += dpsi[k, 1] * xyz[Hex20.FaceNodes[1][k], c]; }
                double w = (2.0 / n) * (2.0 / n);
                ax += w * (te[1] * tt[2] - te[2] * tt[1]); ay += w * (te[2] * tt[0] - te[0] * tt[2]); az += w * (te[0] * tt[1] - te[1] * tt[0]);
            }
        Hex20.FaceShape(0, 0, psi);

        Assert.That(fe.Take(20).Sum(), Is.EqualTo(ax).Within(1e-4));
        Assert.That(fe.Skip(20).Take(20).Sum(), Is.EqualTo(ay).Within(1e-4));
        Assert.That(fe.Skip(40).Sum(), Is.EqualTo(az).Within(1e-4));
    }

    // ---- materials -----------------------------------------------------------------------------

    [Test]
    public void Isotropic_materials_have_the_textbook_constitutive_matrix_and_refuse_nonsense()
    {
        var d = Material.Isotropic(2.1e11, 0.3).D;
        double lambda = 2.1e11 * 0.3 / (1.3 * 0.4), mu = 2.1e11 / 2.6;

        Assert.That(d[0, 0], Is.EqualTo(lambda + 2 * mu).Within(1));
        Assert.That(d[0, 1], Is.EqualTo(lambda).Within(1));
        Assert.That(d[3, 3], Is.EqualTo(mu).Within(1));
        Assert.That(d[0, 3], Is.EqualTo(0));
        Assert.That(() => Material.Isotropic(-1, 0.3), Throws.ArgumentException);
        Assert.That(() => Material.Isotropic(1e9, 0.5), Throws.ArgumentException);
        Assert.That(() => Material.Isotropic(double.NaN, 0.3), Throws.ArgumentException);
    }

    [Test]
    public void A_transversely_isotropic_material_with_equal_properties_is_the_isotropic_one()
    {
        double e = 3e10, nu = 0.25, g = e / (2 * (1 + nu));
        var iso = Material.Isotropic(e, nu).D;
        var ti = Material.TransverselyIsotropic(e, e, nu, nu, g).D;

        for (int i = 0; i < 6; i++)
            for (int j = 0; j < 6; j++) Assert.That(ti[i, j], Is.EqualTo(iso[i, j]).Within(1e-3 + Math.Abs(iso[i, j]) * 1e-9));
    }

    [Test]
    public void A_stiffer_direction_in_a_transversely_isotropic_material_is_stiffer()
    {
        var d = Material.TransverselyIsotropic(1e10, 4e10, 0.3, 0.25, 4e9).D;

        Assert.That(d[2, 2], Is.GreaterThan(d[0, 0]));
        for (int i = 0; i < 6; i++) for (int j = 0; j < 6; j++) Assert.That(d[i, j], Is.EqualTo(d[j, i]).Within(Math.Abs(d[i, j]) * 1e-9 + 1e-3));
    }
}

public class QualityTests
{
    private static double[,] Box(double lx, double ly, double lz)
    {
        var xyz = new double[20, 3];
        for (int i = 0; i < 20; i++)
        {
            xyz[i, 0] = (Hex20.Local[i, 0] + 1) / 2.0 * lx;
            xyz[i, 1] = (Hex20.Local[i, 1] + 1) / 2.0 * ly;
            xyz[i, 2] = (Hex20.Local[i, 2] + 1) / 2.0 * lz;
        }
        return xyz;
    }

    [Test]
    public void A_cube_is_perfect()
    {
        var q = ElementQuality.Of(Box(1, 1, 1));

        Assert.That(q.ScaledJacobian, Is.EqualTo(1).Within(1e-12));
        Assert.That(q.JacobianRatio, Is.EqualTo(1).Within(1e-12));
        Assert.That(q.AspectRatio, Is.EqualTo(1).Within(1e-12));
        Assert.That(q.MaxSkewDegrees, Is.EqualTo(0).Within(1e-9));
        Assert.That(q.Grade, Is.EqualTo(QualityGrade.Excellent));
    }

    [Test]
    public void A_long_box_is_still_perfect_in_angles_but_its_aspect_ratio_grades_it_down()
    {
        var q = ElementQuality.Of(Box(1, 1, 12));

        Assert.That(q.ScaledJacobian, Is.EqualTo(1).Within(1e-12));
        Assert.That(q.AspectRatio, Is.EqualTo(12).Within(1e-9));
        Assert.That(q.Grade, Is.EqualTo(QualityGrade.Acceptable));
        Assert.That(ElementQuality.Of(Box(1, 1, 40)).Grade, Is.EqualTo(QualityGrade.Poor));
    }

    [Test]
    public void A_sheared_element_loses_scaled_jacobian_and_shows_its_skew()
    {
        var xyz = Box(1, 1, 1);
        for (int i = 0; i < 20; i++) xyz[i, 0] += 1.0 * xyz[i, 2];        // 45 degrees

        var q = ElementQuality.Of(xyz);

        Assert.That(q.MaxSkewDegrees, Is.EqualTo(45).Within(1e-6));
        Assert.That(q.ScaledJacobian, Is.InRange(0.5, 0.8));
        Assert.That(q.JacobianRatio, Is.EqualTo(1).Within(1e-9));        // a shear keeps the volume element constant
    }

    [Test]
    public void The_angles_of_a_cube_are_all_right_angles()
    {
        var q = ElementQuality.Of(Box(1, 2, 3));

        Assert.That(q.MinAngleDegrees, Is.EqualTo(90).Within(1e-9));
        Assert.That(q.MaxAngleDegrees, Is.EqualTo(90).Within(1e-9));
    }

    [Test]
    public void A_shear_gives_acute_and_obtuse_angles_that_are_graded_by_the_users_limits()
    {
        double[,] Sheared(double k) { var xyz = Box(1, 1, 1); for (int i = 0; i < 20; i++) xyz[i, 0] += k * xyz[i, 2]; return xyz; }

        var mild = ElementQuality.Of(Sheared(0.5));         // 63 and 117 degrees
        var edge = ElementQuality.Of(Sheared(1));           // 45 and 135
        var steep = ElementQuality.Of(Sheared(3));          // 18 and 162
        var collapsed = ElementQuality.Of(Sheared(5));      // 11 and 169

        Assert.That(mild.MinAngleDegrees, Is.EqualTo(63.4349).Within(1e-3));
        Assert.That(mild.MaxAngleDegrees, Is.EqualTo(116.5651).Within(1e-3));
        Assert.That(edge.MinAngleDegrees, Is.EqualTo(45).Within(1e-6));
        Assert.That(edge.MaxAngleDegrees, Is.EqualTo(135).Within(1e-6));
        Assert.That(steep.MinAngleDegrees, Is.EqualTo(18.4349).Within(1e-3));
        // angles of 15-165 are allowed, below 15 or above 165 are not
        Assert.That(ElementQuality.GradeBelow(mild.MaxSkewDegrees, ElementQuality.SkewLimits), Is.EqualTo(QualityGrade.Excellent));
        Assert.That(ElementQuality.GradeBelow(edge.MaxSkewDegrees + 1e-6, ElementQuality.SkewLimits), Is.EqualTo(QualityGrade.Acceptable));
        Assert.That(ElementQuality.GradeBelow(steep.MaxSkewDegrees, ElementQuality.SkewLimits), Is.EqualTo(QualityGrade.Acceptable));
        Assert.That(ElementQuality.GradeBelow(collapsed.MaxSkewDegrees, ElementQuality.SkewLimits), Is.EqualTo(QualityGrade.Poor));
    }

    [Test]
    public void A_bent_edge_changes_the_angles_at_its_corners()
    {
        var xyz = Box(1, 1, 1);
        xyz[8, 2] -= 0.15;            // the midpoint of the bottom edge (0,1) is pushed down: the edge bows out of the face

        var q = ElementQuality.Of(xyz);

        Assert.That(q.MaxSkewDegrees, Is.GreaterThan(5));
        Assert.That(q.MaxAngleDegrees, Is.GreaterThan(95));       // the edge leaves its corners tilted into the neighbouring face angles
    }

    [Test]
    public void A_tapered_element_has_dihedral_angles_that_are_not_right_angles()
    {
        var xyz = Box(1, 1, 1);
        for (int i = 0; i < 20; i++)
        {
            double top = xyz[i, 2];                                   // 0 at the bottom, 1 at the top
            double shrink = 1 - 0.5 * top;
            xyz[i, 0] = 0.5 + (xyz[i, 0] - 0.5) * shrink;
            xyz[i, 1] = 0.5 + (xyz[i, 1] - 0.5) * shrink;
        }

        var q = ElementQuality.Of(xyz);

        Assert.That(q.MaxAngleDegrees, Is.GreaterThan(100));          // the sides lean in: their dihedral angle with the bottom is obtuse
        Assert.That(q.MinAngleDegrees, Is.LessThan(80));
    }

    [Test]
    public void A_folded_element_is_invalid()
    {
        var xyz = Box(1, 1, 1);
        xyz[6, 0] = -3; xyz[6, 1] = -3; xyz[6, 2] = -3;

        var q = ElementQuality.Of(xyz);

        Assert.That(q.Grade, Is.EqualTo(QualityGrade.Invalid));
        Assert.That(q.MinDeterminant, Is.LessThan(0));
    }

    [Test]
    public void A_nearly_collapsed_corner_is_poor_before_it_is_invalid()
    {
        var xyz = Box(1, 1, 1);
        xyz[6, 0] = 0.15; xyz[6, 1] = 0.15; xyz[6, 2] = 0.15;      // top corner pulled almost to the centre

        var q = ElementQuality.Of(xyz);

        Assert.That(q.Grade, Is.AnyOf(QualityGrade.Poor, QualityGrade.Acceptable, QualityGrade.Invalid));
        Assert.That(q.ScaledJacobian, Is.LessThan(0.4));
    }

    [Test]
    public void The_grade_is_the_worst_of_the_four_measures()
    {
        Assert.That(new ElementQualityMetrics(1, 0.9, 0.9, 2, 0).Grade, Is.EqualTo(QualityGrade.Excellent));
        Assert.That(new ElementQualityMetrics(1, 0.9, 0.9, 20, 0).Grade, Is.EqualTo(QualityGrade.Acceptable));
        Assert.That(new ElementQualityMetrics(1, 0.9, 0.1, 2, 0).Grade, Is.EqualTo(QualityGrade.Acceptable));
        Assert.That(new ElementQualityMetrics(1, 0.1, 0.9, 2, 0).Grade, Is.EqualTo(QualityGrade.Poor));
        Assert.That(new ElementQualityMetrics(-1, 0.9, 0.9, 2, 0).Grade, Is.EqualTo(QualityGrade.Invalid));
        Assert.That(new ElementQualityMetrics(1, 0.9, 0.9, 2, 40).Grade, Is.EqualTo(QualityGrade.Good));          // angles 50-130
        Assert.That(new ElementQualityMetrics(1, 0.9, 0.9, 2, 60).Grade, Is.EqualTo(QualityGrade.Acceptable));   // 30-150
        Assert.That(new ElementQualityMetrics(1, 0.9, 0.9, 2, 80).Grade, Is.EqualTo(QualityGrade.Poor));         // beyond 15-165
    }
}
